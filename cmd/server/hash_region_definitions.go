package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/meshcore-analyzer/admindb"
)

const (
	maxHashRegionDescriptionLen = 2000
	maxGeoJSONRingPositions     = 4096
	maxGeoJSONPolygonRings      = 256
	maxGeoJSONMultiMembers      = 256
	maxGeoJSONTotalPositions    = 16384
	maxGeoJSONValidationWork    = 16_000_000
)

type hashRegionDefinitionPayload struct {
	Name        string          `json:"name"`
	ParentName  string          `json:"parentName,omitempty"`
	Description string          `json:"description,omitempty"`
	Color       string          `json:"color,omitempty"`
	Geometry    json.RawMessage `json:"geometry,omitempty"`
}

type hashRegionDefinitionsResponse struct {
	HashRegions           []string                      `json:"hashRegions"`
	HashRegionDefinitions []hashRegionDefinitionPayload `json:"hashRegionDefinitions"`
}

type hashRegionGeometryPayload struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

func newHashRegionDefinitionsResponse(definitions []admindb.HashRegionDefinition) (hashRegionDefinitionsResponse, error) {
	names := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		names = append(names, definition.Name)
	}
	payloads, err := hashRegionDefinitionPayloads(definitions)
	if err != nil {
		return hashRegionDefinitionsResponse{}, err
	}
	return hashRegionDefinitionsResponse{
		HashRegions:           names,
		HashRegionDefinitions: payloads,
	}, nil
}

func cleanHashRegionDefinitions(input []hashRegionDefinitionPayload) ([]admindb.HashRegionDefinition, error) {
	return cleanHashRegionDefinitionsWithTrusted(input, nil)
}

func cleanHashRegionDefinitionsWithTrusted(input []hashRegionDefinitionPayload, trusted []admindb.HashRegionDefinition) ([]admindb.HashRegionDefinition, error) {
	if len(input) > maxHashRegionEntries {
		return nil, fmt.Errorf("too many hash regions (max %d)", maxHashRegionEntries)
	}

	trustedGeometry := make(map[string]string, len(trusted))
	for _, definition := range trusted {
		trustedGeometry[definition.Name] = definition.GeometryJSON
	}

	definitions := make([]admindb.HashRegionDefinition, 0, len(input))
	byName := make(map[string]bool, len(input))
	var requestValidationWork int64
	for _, raw := range input {
		name := normalizeHashRegionName(raw.Name)
		if name == "" {
			return nil, errors.New("hash region name is required")
		}
		if utf8.RuneCountInString(name) > maxHashRegionNameLen {
			return nil, fmt.Errorf("hash region name %q exceeds %d characters", name, maxHashRegionNameLen)
		}
		if byName[name] {
			return nil, fmt.Errorf("duplicate hash region %q", name)
		}
		byName[name] = true

		description := strings.TrimSpace(raw.Description)
		if utf8.RuneCountInString(description) > maxHashRegionDescriptionLen {
			return nil, fmt.Errorf("hash region description for %q exceeds %d characters", name, maxHashRegionDescriptionLen)
		}
		regionColor, err := normalizeHashRegionColor(raw.Color)
		if err != nil {
			return nil, fmt.Errorf("invalid color for %q: %w", name, err)
		}
		geometryJSON, geometryWork := "", int64(0)
		canonicalGeometry, canonicalErr := canonicalHashRegionGeometry(raw.Geometry)
		if storedGeometry, ok := trustedGeometry[name]; ok && canonicalErr == nil && canonicalGeometry == storedGeometry {
			geometryJSON = storedGeometry
		} else {
			remainingWork := maxGeoJSONValidationWork - requestValidationWork
			geometryJSON, geometryWork, err = normalizeHashRegionGeometry(raw.Geometry, remainingWork)
			if err != nil {
				return nil, fmt.Errorf("invalid geometry for %q: %w", name, err)
			}
		}
		requestValidationWork += geometryWork
		if requestValidationWork > maxGeoJSONValidationWork {
			return nil, fmt.Errorf("request validation work limit exceeded (%d)", maxGeoJSONValidationWork)
		}
		definitions = append(definitions, admindb.HashRegionDefinition{
			Name:         name,
			ParentName:   normalizeHashRegionName(raw.ParentName),
			Description:  description,
			Color:        regionColor,
			GeometryJSON: geometryJSON,
		})
	}

	parents := make(map[string]string, len(definitions))
	for _, definition := range definitions {
		if definition.ParentName != "" {
			if definition.ParentName == definition.Name {
				return nil, fmt.Errorf("hash region %q cannot be its own parent", definition.Name)
			}
			if !byName[definition.ParentName] {
				return nil, fmt.Errorf("parent %q for hash region %q does not exist", definition.ParentName, definition.Name)
			}
		}
		parents[definition.Name] = definition.ParentName
	}
	if cycleAt := hashRegionParentCycle(parents); cycleAt != "" {
		return nil, fmt.Errorf("hash region hierarchy contains a cycle at %q", cycleAt)
	}
	return definitions, nil
}

func canonicalHashRegionGeometry(raw json.RawMessage) (string, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", nil
	}
	geometry, err := decodeHashRegionGeometry(raw)
	if err != nil {
		return "", err
	}
	// Stored geometry can predate numeric-ordinate validation. Keep this linear
	// source check before trusted canonical reuse, without repeating topology work.
	if bytes.Contains(geometry.Coordinates, []byte("null")) {
		return "", errors.New("coordinate ordinates must be numbers, not null")
	}
	canonical, err := json.Marshal(struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}{Type: geometry.Type, Coordinates: geometry.Coordinates})
	if err != nil {
		return "", err
	}
	return string(canonical), nil
}

func decodeHashRegionGeometry(raw json.RawMessage) (hashRegionGeometryPayload, error) {
	var geometry hashRegionGeometryPayload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&geometry); err != nil {
		return geometry, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return geometry, errors.New("geometry must contain exactly one JSON value")
	}
	return geometry, nil
}

func normalizeHashRegionColor(input string) (string, error) {
	color := strings.TrimSpace(input)
	if color == "" {
		return "", nil
	}
	if len(color) != 7 || color[0] != '#' {
		return "", errors.New("must use #RRGGBB format")
	}
	for index := 1; index < len(color); index++ {
		character := color[index]
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return "", errors.New("must use #RRGGBB format")
		}
	}
	return strings.ToLower(color), nil
}

func hashRegionParentCycle(parents map[string]string) string {
	const (
		visiting = 1
		visited  = 2
	)
	state := make(map[string]int, len(parents))
	var visit func(string) string
	visit = func(name string) string {
		switch state[name] {
		case visiting:
			return name
		case visited:
			return ""
		}
		state[name] = visiting
		if parent := parents[name]; parent != "" {
			if cycleAt := visit(parent); cycleAt != "" {
				return cycleAt
			}
		}
		state[name] = visited
		return ""
	}
	for name := range parents {
		if cycleAt := visit(name); cycleAt != "" {
			return cycleAt
		}
	}
	return ""
}

func normalizeHashRegionGeometry(raw json.RawMessage, remainingWork int64) (string, int64, error) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", 0, nil
	}
	geometry, err := decodeHashRegionGeometry(raw)
	if err != nil {
		return "", 0, errors.New("must be valid GeoJSON")
	}
	if len(geometry.Coordinates) == 0 || bytes.Equal(bytes.TrimSpace(geometry.Coordinates), []byte("null")) {
		return "", 0, errors.New("coordinates are required")
	}
	// Unmarshalling null into float64 silently produces zero. Reject it in the
	// raw coordinates before typed decoding; numeric arrays cannot contain
	// "null", and the typed decoder rejects strings and all other nonnumbers.
	if bytes.Contains(geometry.Coordinates, []byte("null")) {
		return "", 0, errors.New("coordinate ordinates must be numbers, not null")
	}
	var validationWork int64
	switch geometry.Type {
	case "Polygon":
		var polygon [][][]float64
		if err := json.Unmarshal(geometry.Coordinates, &polygon); err != nil {
			return "", 0, errors.New("Polygon coordinates are invalid")
		}
		if err := validateGeoJSONCoordinateShapes([][][][]float64{polygon}); err != nil {
			return "", 0, err
		}
		work, err := validateGeoJSONComplexity([][][][]float64{polygon}, false)
		if err != nil {
			return "", 0, err
		}
		validationWork = work
		if validationWork > remainingWork {
			return "", 0, fmt.Errorf("request validation work limit exceeded (%d)", maxGeoJSONValidationWork)
		}
		if err := validateGeoJSONPolygon(polygon); err != nil {
			return "", 0, err
		}
	case "MultiPolygon":
		var multiPolygon [][][][]float64
		if err := json.Unmarshal(geometry.Coordinates, &multiPolygon); err != nil || len(multiPolygon) == 0 {
			return "", 0, errors.New("MultiPolygon coordinates are invalid")
		}
		if err := validateGeoJSONCoordinateShapes(multiPolygon); err != nil {
			return "", 0, err
		}
		work, err := validateGeoJSONComplexity(multiPolygon, true)
		if err != nil {
			return "", 0, err
		}
		validationWork = work
		multiWork, err := validateGeoJSONMultiPolygonWork(multiPolygon)
		if err != nil {
			return "", 0, err
		}
		validationWork += multiWork
		if validationWork > maxGeoJSONValidationWork {
			return "", 0, fmt.Errorf("geometry exceeds validation work limit (%d)", maxGeoJSONValidationWork)
		}
		if validationWork > remainingWork {
			return "", 0, fmt.Errorf("request validation work limit exceeded (%d)", maxGeoJSONValidationWork)
		}
		for _, polygon := range multiPolygon {
			if err := validateGeoJSONPolygon(polygon); err != nil {
				return "", 0, err
			}
		}
		for polygonIndex, polygon := range multiPolygon {
			for otherIndex := 0; otherIndex < polygonIndex; otherIndex++ {
				if polygonsOverlap(multiPolygon[otherIndex], polygon) {
					return "", 0, fmt.Errorf("MultiPolygon members %d and %d overlap", otherIndex, polygonIndex)
				}
			}
		}
	default:
		return "", 0, errors.New("type must be Polygon or MultiPolygon")
	}

	canonical, err := json.Marshal(struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}{Type: geometry.Type, Coordinates: geometry.Coordinates})
	if err != nil {
		return "", 0, fmt.Errorf("encode geometry: %w", err)
	}
	return string(canonical), validationWork, nil
}

func validateGeoJSONComplexity(polygons [][][][]float64, multiPolygon bool) (int64, error) {
	if multiPolygon && len(polygons) > maxGeoJSONMultiMembers {
		return 0, fmt.Errorf("MultiPolygon has too many members (max %d)", maxGeoJSONMultiMembers)
	}
	totalPositions := 0
	var work int64
	for _, polygon := range polygons {
		if len(polygon) > maxGeoJSONPolygonRings {
			return 0, fmt.Errorf("Polygon has too many rings (max %d)", maxGeoJSONPolygonRings)
		}
		for _, ring := range polygon {
			totalPositions += len(ring)
			if totalPositions > maxGeoJSONTotalPositions {
				return 0, fmt.Errorf("geometry has too many total positions (max %d)", maxGeoJSONTotalPositions)
			}
			edges := int64(max(0, len(ring)-1))
			if edges > 3 {
				work += edges * (edges - 3) / 2
			}
		}
		for ringIndex := 1; ringIndex < len(polygon); ringIndex++ {
			edges := int64(max(0, len(polygon[ringIndex])-1))
			shellEdges := int64(max(0, len(polygon[0])-1))
			work += shellEdges*edges + shellEdges
			for otherIndex := 1; otherIndex < ringIndex; otherIndex++ {
				otherEdges := int64(max(0, len(polygon[otherIndex])-1))
				work += edges*otherEdges + edges + otherEdges
			}
		}
	}
	if work > maxGeoJSONValidationWork {
		return 0, fmt.Errorf("geometry exceeds validation work limit (%d)", maxGeoJSONValidationWork)
	}
	return work, nil
}

func validateGeoJSONCoordinateShapes(polygons [][][][]float64) error {
	for _, polygon := range polygons {
		if len(polygon) == 0 {
			return errors.New("Polygon must contain at least one ring")
		}
		for _, ring := range polygon {
			if len(ring) < 4 {
				return errors.New("each Polygon ring must contain at least four positions")
			}
			for _, position := range ring {
				if len(position) < 2 {
					return errors.New("positions must contain longitude [-180,180] and latitude [-90,90]")
				}
			}
		}
	}
	return nil
}

func validateGeoJSONMultiPolygonWork(polygons [][][][]float64) (int64, error) {
	var work int64
	for polygonIndex, polygon := range polygons {
		for otherIndex := 0; otherIndex < polygonIndex; otherIndex++ {
			other := polygons[otherIndex]
			if !polygonBoundsOverlap(polygon, other) {
				continue
			}
			var polygonEdges, otherEdges int64
			for _, ring := range polygon {
				polygonEdges += int64(len(ring) - 1)
			}
			for _, ring := range other {
				otherEdges += int64(len(ring) - 1)
			}
			work += polygonEdges*otherEdges + int64(len(polygon[0])-1)*otherEdges + int64(len(other[0])-1)*polygonEdges
			if work > maxGeoJSONValidationWork {
				return 0, fmt.Errorf("geometry exceeds validation work limit (%d)", maxGeoJSONValidationWork)
			}
		}
	}
	return work, nil
}

func validateGeoJSONPolygon(polygon [][][]float64) error {
	if len(polygon) == 0 {
		return errors.New("Polygon must contain at least one ring")
	}
	for _, ring := range polygon {
		if err := validateGeoJSONRing(ring); err != nil {
			return err
		}
	}

	shell := polygon[0]
	for holeIndex := 1; holeIndex < len(polygon); holeIndex++ {
		hole := polygon[holeIndex]
		if ringsIntersect(shell, hole) || !pointStrictlyInsideRing(hole[0], shell) {
			return fmt.Errorf("Polygon hole %d must be strictly inside and not intersect the shell", holeIndex)
		}
		for otherIndex := 1; otherIndex < holeIndex; otherIndex++ {
			other := polygon[otherIndex]
			if ringsIntersect(hole, other) || pointStrictlyInsideRing(hole[0], other) || pointStrictlyInsideRing(other[0], hole) {
				return fmt.Errorf("Polygon holes %d and %d intersect or contain one another", otherIndex, holeIndex)
			}
		}
	}
	return nil
}

func validateGeoJSONRing(ring [][]float64) error {
	if len(ring) < 4 {
		return errors.New("each Polygon ring must contain at least four positions")
	}
	if len(ring) > maxGeoJSONRingPositions {
		return fmt.Errorf("Polygon ring has too many positions (max %d)", maxGeoJSONRingPositions)
	}
	for _, position := range ring {
		if len(position) < 2 || position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90 {
			return errors.New("positions must contain longitude [-180,180] and latitude [-90,90]")
		}
	}
	first, last := ring[0], ring[len(ring)-1]
	if len(first) != len(last) {
		return errors.New("Polygon rings must be closed")
	}
	for i := range first {
		if first[i] != last[i] {
			return errors.New("Polygon rings must be closed")
		}
	}

	distinct := make(map[[2]float64]struct{}, len(ring)-1)
	var twiceArea float64
	originX, originY := ring[0][0], ring[0][1]
	for i := 0; i < len(ring)-1; i++ {
		distinct[[2]float64{ring[i][0], ring[i][1]}] = struct{}{}
		twiceArea += (ring[i][0]-originX)*(ring[i+1][1]-originY) - (ring[i+1][0]-originX)*(ring[i][1]-originY)
	}
	if len(distinct) < 3 {
		return errors.New("each Polygon ring must contain at least three distinct vertices")
	}
	if twiceArea == 0 {
		return errors.New("Polygon rings must have non-zero area")
	}
	if ringSelfIntersects(ring) {
		return errors.New("Polygon rings must not self-intersect")
	}
	return nil
}

func ringSelfIntersects(ring [][]float64) bool {
	segments := len(ring) - 1
	for i := 0; i < segments; i++ {
		for j := i + 1; j < segments; j++ {
			if j == i+1 || (i == 0 && j == segments-1) {
				continue
			}
			if segmentsIntersect(ring[i], ring[i+1], ring[j], ring[j+1]) {
				return true
			}
		}
	}
	return false
}

func ringsIntersect(a, b [][]float64) bool {
	for i := 0; i < len(a)-1; i++ {
		for j := 0; j < len(b)-1; j++ {
			if segmentsIntersect(a[i], a[i+1], b[j], b[j+1]) {
				return true
			}
		}
	}
	return false
}

func segmentsIntersect(a, b, c, d []float64) bool {
	o1, o2 := orientation(a, b, c), orientation(a, b, d)
	o3, o4 := orientation(c, d, a), orientation(c, d, b)
	if ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0)) {
		return true
	}
	return (o1 == 0 && pointOnSegment(c, a, b)) || (o2 == 0 && pointOnSegment(d, a, b)) ||
		(o3 == 0 && pointOnSegment(a, c, d)) || (o4 == 0 && pointOnSegment(b, c, d))
}

func orientation(a, b, c []float64) float64 {
	return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])
}

func pointOnSegment(point, a, b []float64) bool {
	return point[0] >= math.Min(a[0], b[0]) && point[0] <= math.Max(a[0], b[0]) &&
		point[1] >= math.Min(a[1], b[1]) && point[1] <= math.Max(a[1], b[1])
}

func polygonsOverlap(a, b [][][]float64) bool {
	if !polygonBoundsOverlap(a, b) {
		return false
	}
	for ringAIndex, ringA := range a {
		for ringBIndex, ringB := range b {
			for i := 0; i < len(ringA)-1; i++ {
				for j := 0; j < len(ringB)-1; j++ {
					segmentA, segmentB := ringA[i:i+2], ringB[j:j+2]
					if segmentsProperlyIntersect(segmentA[0], segmentA[1], segmentB[0], segmentB[1]) {
						return true
					}
					if _, ok := collinearOverlapMidpoint(segmentA[0], segmentA[1], segmentB[0], segmentB[1]); ok &&
						boundariesHaveSameFilledSide(ringA, ringAIndex > 0, i, ringB, ringBIndex > 0, j) {
						return true
					}
				}
			}
		}
	}
	for _, point := range a[0][:len(a[0])-1] {
		if pointStrictlyInsidePolygon(point, b) {
			return true
		}
	}
	for _, point := range b[0][:len(b[0])-1] {
		if pointStrictlyInsidePolygon(point, a) {
			return true
		}
	}
	return false
}

func polygonBoundsOverlap(a, b [][][]float64) bool {
	minAX, minAY, maxAX, maxAY := polygonBounds(a)
	minBX, minBY, maxBX, maxBY := polygonBounds(b)
	return maxAX >= minBX && maxBX >= minAX && maxAY >= minBY && maxBY >= minAY
}

func polygonBounds(polygon [][][]float64) (minX, minY, maxX, maxY float64) {
	minX, minY = math.Inf(1), math.Inf(1)
	maxX, maxY = math.Inf(-1), math.Inf(-1)
	for _, ring := range polygon {
		for _, point := range ring {
			minX = math.Min(minX, point[0])
			minY = math.Min(minY, point[1])
			maxX = math.Max(maxX, point[0])
			maxY = math.Max(maxY, point[1])
		}
	}
	return minX, minY, maxX, maxY
}

func segmentsProperlyIntersect(a, b, c, d []float64) bool {
	o1, o2 := orientation(a, b, c), orientation(a, b, d)
	o3, o4 := orientation(c, d, a), orientation(c, d, b)
	return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))
}

func collinearOverlapMidpoint(a, b, c, d []float64) ([]float64, bool) {
	if orientation(a, b, c) != 0 || orientation(a, b, d) != 0 {
		return nil, false
	}
	useX := math.Abs(a[0]-b[0]) >= math.Abs(a[1]-b[1])
	axis := 1
	if useX {
		axis = 0
	}
	low := math.Max(math.Min(a[axis], b[axis]), math.Min(c[axis], d[axis]))
	high := math.Min(math.Max(a[axis], b[axis]), math.Max(c[axis], d[axis]))
	if high <= low {
		return nil, false
	}
	value := (low + high) / 2
	ratio := (value - a[axis]) / (b[axis] - a[axis])
	return []float64{a[0] + ratio*(b[0]-a[0]), a[1] + ratio*(b[1]-a[1])}, true
}

func boundariesHaveSameFilledSide(first [][]float64, firstHole bool, firstEdge int, second [][]float64, secondHole bool, secondEdge int) bool {
	firstSide := ringFilledSide(first, firstHole)
	secondSide := ringFilledSide(second, secondHole)
	firstDX := first[firstEdge+1][0] - first[firstEdge][0]
	firstDY := first[firstEdge+1][1] - first[firstEdge][1]
	secondDX := second[secondEdge+1][0] - second[secondEdge][0]
	secondDY := second[secondEdge+1][1] - second[secondEdge][1]
	if firstDX*secondDX+firstDY*secondDY < 0 {
		secondSide = -secondSide
	}
	return firstSide == secondSide
}

func ringFilledSide(ring [][]float64, hole bool) int {
	originX, originY := ring[0][0], ring[0][1]
	var twiceArea float64
	for index := 0; index < len(ring)-1; index++ {
		twiceArea += (ring[index][0]-originX)*(ring[index+1][1]-originY) -
			(ring[index+1][0]-originX)*(ring[index][1]-originY)
	}
	side := 1
	if twiceArea < 0 {
		side = -1
	}
	if hole {
		side = -side
	}
	return side
}

func pointStrictlyInsidePolygon(point []float64, polygon [][][]float64) bool {
	if !pointStrictlyInsideRing(point, polygon[0]) {
		return false
	}
	for holeIndex := 1; holeIndex < len(polygon); holeIndex++ {
		if pointStrictlyInsideRing(point, polygon[holeIndex]) || pointOnRing(point, polygon[holeIndex]) {
			return false
		}
	}
	return true
}

func pointOnRing(point []float64, ring [][]float64) bool {
	for i := 0; i < len(ring)-1; i++ {
		if orientation(ring[i], ring[i+1], point) == 0 && pointOnSegment(point, ring[i], ring[i+1]) {
			return true
		}
	}
	return false
}

func pointStrictlyInsideRing(point []float64, ring [][]float64) bool {
	inside := false
	for i, j := 0, len(ring)-2; i < len(ring)-1; j, i = i, i+1 {
		if orientation(ring[j], ring[i], point) == 0 && pointOnSegment(point, ring[j], ring[i]) {
			return false
		}
		if (ring[i][1] > point[1]) != (ring[j][1] > point[1]) &&
			point[0] < (ring[j][0]-ring[i][0])*(point[1]-ring[i][1])/(ring[j][1]-ring[i][1])+ring[i][0] {
			inside = !inside
		}
	}
	return inside
}

func hashRegionDefinitionPayloads(definitions []admindb.HashRegionDefinition) ([]hashRegionDefinitionPayload, error) {
	out := make([]hashRegionDefinitionPayload, 0, len(definitions))
	for _, definition := range definitions {
		var geometry json.RawMessage
		if definition.GeometryJSON != "" {
			if !json.Valid([]byte(definition.GeometryJSON)) {
				return nil, fmt.Errorf("stored geometry for %q is invalid JSON", definition.Name)
			}
			geometry = json.RawMessage(definition.GeometryJSON)
		}
		out = append(out, hashRegionDefinitionPayload{
			Name:        definition.Name,
			ParentName:  definition.ParentName,
			Description: definition.Description,
			Color:       definition.Color,
			Geometry:    geometry,
		})
	}
	return out, nil
}
