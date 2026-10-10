package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/meshcore-analyzer/admindb"
)

// These fixtures keep the ring closed even when a null would decode as zero.
func nonNumericHashRegionGeometries() []struct{ name, geometry string } {
	var cases []struct{ name, geometry string }
	for _, kind := range []string{"Polygon", "MultiPolygon"} {
		for _, ordinate := range []string{"null", `"0"`, "true", "false"} {
			for _, position := range []string{"longitude", "latitude", "extra"} {
				point := fmt.Sprintf("[%s,0]", ordinate)
				if position == "latitude" {
					point = fmt.Sprintf("[0,%s]", ordinate)
				} else if position == "extra" {
					point = fmt.Sprintf("[0,0,0,%s]", ordinate)
				}
				coordinates := fmt.Sprintf("[[%s,[1,0],[0,1],%s]]", point, point)
				if kind == "MultiPolygon" {
					coordinates = "[" + coordinates + "]"
				}
				cases = append(cases, struct{ name, geometry string }{
					kind + "/" + position + "/" + ordinate,
					fmt.Sprintf(`{"type":%q,"coordinates":%s}`, kind, coordinates),
				})
			}
		}
		coordinates := `[[[null,null],[1,0],[0,1],[null,null]]]`
		if kind == "MultiPolygon" {
			coordinates = "[" + coordinates + "]"
		}
		cases = append(cases, struct{ name, geometry string }{
			kind + "/null-pair",
			fmt.Sprintf(`{"type":%q,"coordinates":%s}`, kind, coordinates),
		})
	}
	return cases
}

func TestHashRegionGeometryTrustedLegacyNullRejected(t *testing.T) {
	for _, test := range nonNumericHashRegionGeometries() {
		if !strings.Contains(test.geometry, "null") {
			continue
		}
		t.Run(test.name, func(t *testing.T) {
			raw := json.RawMessage(test.geometry)
			if got, err := canonicalHashRegionGeometry(raw); err == nil || got != "" {
				t.Errorf("canonicalization accepted legacy null: %q, %v", got, err)
			}
			trusted := []admindb.HashRegionDefinition{{Name: "#legacy", GeometryJSON: test.geometry}}
			input := []hashRegionDefinitionPayload{{Name: "legacy", Geometry: raw}}
			if got, err := cleanHashRegionDefinitionsWithTrusted(input, trusted); err == nil || got != nil {
				t.Errorf("trusted cleaner accepted legacy null: %#v, %v", got, err)
			}
			if got, work, err := normalizeHashRegionGeometry(raw, 0); err == nil || got != "" || work != 0 {
				t.Errorf("legacy null rejection spent work: %q, %d, %v", got, work, err)
			}
		})
	}
}

func TestAdminHashRegionDefinitionsTrustedLegacyNullPreservesSaved(t *testing.T) {
	for _, test := range nonNumericHashRegionGeometries() {
		if !strings.Contains(test.geometry, "null") {
			continue
		}
		t.Run(test.name, func(t *testing.T) {
			srv := newTestAdminServer(t)
			// Simulate data saved before numeric-ordinate validation existed.
			saved := []admindb.HashRegionDefinition{
				{Name: "#legacy", Description: "retain metadata", Color: "#123456", GeometryJSON: test.geometry},
				{Name: "#child", ParentName: "#legacy", Description: "retain hierarchy"},
			}
			if err := srv.admin.ReplaceHashRegionDefinitions(saved); err != nil {
				t.Fatal(err)
			}
			get := func() string {
				recorder := httptest.NewRecorder()
				srv.handleAdminGetHashRegions(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions", nil))
				if recorder.Code != http.StatusOK {
					t.Fatalf("GET status = %d: %s", recorder.Code, recorder.Body.String())
				}
				return recorder.Body.String()
			}
			before := get()
			body := fmt.Sprintf(`{"hashRegionDefinitions":[{"name":"legacy","description":"must not replace metadata","geometry":%s},{"name":"#replacement"}]}`, test.geometry)
			recorder := httptest.NewRecorder()
			srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "null") {
				t.Errorf("legacy null PUT status = %d, want numeric rejection: %s", recorder.Code, recorder.Body.String())
			}
			if after := get(); after != before {
				t.Errorf("legacy null PUT changed persisted state: before=%s after=%s", before, after)
			}
		})
	}
}

func TestNormalizeHashRegionGeometryRejectsNonNumericOrdinates(t *testing.T) {
	for _, test := range nonNumericHashRegionGeometries() {
		t.Run(test.name, func(t *testing.T) {
			got, work, err := normalizeHashRegionGeometry(json.RawMessage(test.geometry), maxGeoJSONValidationWork)
			if err == nil || got != "" || work != 0 {
				t.Fatalf("normalizer returned %q, %v; want rejection and no geometry", got, err)
			}
		})
	}
}

func TestAdminHashRegionDefinitionsNonNumericOrdinatesPreserveSaved(t *testing.T) {
	for _, test := range nonNumericHashRegionGeometries() {
		t.Run(test.name, func(t *testing.T) {
			srv := newTestAdminServer(t)
			saved := `{"hashRegionDefinitions":[{"name":"#saved","description":"retain metadata","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,1],[0,0]]]}},{"name":"#child","parentName":"#saved","description":"retain hierarchy"}]}`
			put := func(body string) *httptest.ResponseRecorder {
				recorder := httptest.NewRecorder()
				srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewBufferString(body)))
				return recorder
			}
			get := func() []byte {
				recorder := httptest.NewRecorder()
				srv.handleAdminGetHashRegions(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions", nil))
				if recorder.Code != http.StatusOK {
					t.Fatalf("GET status = %d: %s", recorder.Code, recorder.Body.String())
				}
				return recorder.Body.Bytes()
			}
			if recorder := put(saved); recorder.Code != http.StatusOK {
				t.Fatalf("seed PUT status = %d: %s", recorder.Code, recorder.Body.String())
			}
			before := get()
			body := fmt.Sprintf(`{"hashRegionDefinitions":[{"name":"#replacement"},{"name":"#invalid","geometry":%s}]}`, test.geometry)
			if recorder := put(body); recorder.Code != http.StatusBadRequest {
				t.Errorf("invalid PUT status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
			if after := get(); !bytes.Equal(before, after) {
				t.Errorf("rejected PUT changed saved definitions: before=%s after=%s", before, after)
			}
		})
	}
}

func TestNormalizeHashRegionGeometryPreservesNumericOrdinates(t *testing.T) {
	for _, kind := range []string{"Polygon", "MultiPolygon"} {
		t.Run(kind, func(t *testing.T) {
			coordinates := `[[[0,0,10,2e1],[1,0,10,20],[0,1,10,20],[0,0,10,2e1]]]`
			if kind == "MultiPolygon" {
				coordinates = "[" + coordinates + "]"
			}
			raw := fmt.Sprintf(`{"type":%q,"coordinates":%s}`, kind, coordinates)
			got, work, err := normalizeHashRegionGeometry(json.RawMessage(raw), maxGeoJSONValidationWork)
			if err != nil || got != raw || work != 0 {
				t.Fatalf("normalizer returned %q, %v; want unchanged numeric geometry %s", got, err, raw)
			}
		})
	}
	if got, work, err := normalizeHashRegionGeometry(json.RawMessage("null"), maxGeoJSONValidationWork); err != nil || got != "" || work != 0 {
		t.Fatalf("optional null geometry = %q, %v; want empty geometry", got, err)
	}
}

func TestConfigHashRegionDefinitionsReturnsPublicMetadata(t *testing.T) {
	srv := newTestAdminServer(t)
	body := []byte(`{"hashRegionDefinitions":[{"name":"#us-tn","description":"Tennessee regional scope","color":"#12ABef","geometry":{"type":"Polygon","coordinates":[[[-90,35],[-81,35],[-81,37],[-90,35]]]}}]}`)
	putReq := httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(body))
	putRecorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(putRecorder, putReq)
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200: %s", putRecorder.Code, putRecorder.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet, "/api/config/hash-region-definitions", nil)
	recorder := httptest.NewRecorder()
	srv.handleConfigHashRegionDefinitions(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var definitions []hashRegionDefinitionPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &definitions); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(definitions) != 1 || definitions[0].Name != "#us-tn" || definitions[0].Description != "Tennessee regional scope" || definitions[0].Color != "#12abef" {
		t.Fatalf("definitions = %#v, want public region metadata", definitions)
	}
}

func TestHashRegionDefinitionEndpointsRejectCorruptStoredGeometry(t *testing.T) {
	srv := newTestAdminServer(t)
	if err := srv.admin.ReplaceHashRegionDefinitions([]admindb.HashRegionDefinition{{Name: "#broken", GeometryJSON: "{"}}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		handler http.HandlerFunc
	}{
		{name: "public config", handler: srv.handleConfigHashRegionDefinitions},
		{name: "admin", handler: srv.handleAdminGetHashRegions},
	} {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			test.handler(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
			if recorder.Code != http.StatusInternalServerError || !json.Valid(recorder.Body.Bytes()) {
				t.Fatalf("status = %d body = %q, want JSON 500", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestAdminHashRegionDefinitionsRejectInvalidHierarchyAndGeometry(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "missing parent",
			body: `{"hashRegionDefinitions":[{"name":"#us-tn-bna","parentName":"#us-tn"}]}`,
		},
		{
			name: "parent cycle",
			body: `{"hashRegionDefinitions":[{"name":"#a","parentName":"#b"},{"name":"#b","parentName":"#a"}]}`,
		},
		{
			name: "invalid color",
			body: `{"hashRegionDefinitions":[{"name":"#a","color":"red; background:url(javascript:alert(1))"}]}`,
		},
		{
			name: "unsupported geometry",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}}]}`,
		},
		{
			name: "unclosed polygon",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,1]]]}}]}`,
		},
		{
			name: "coordinate outside longitude range",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[181,0],[1,0],[1,1],[181,0]]]}}]}`,
		},
		{
			name: "ring endpoints differ in altitude",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0,1],[1,0,1],[1,1,1],[0,0,2]]]}}]}`,
		},
		{
			name: "ring has fewer than three distinct vertices",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[0,0],[0,0]]]}}]}`,
		},
		{
			name: "ring has zero area",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[2,0],[0,0]]]}}]}`,
		},
		{
			name: "ring self intersects",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}}]}`,
		},
		{
			name: "hole is outside shell",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[5,0],[5,5],[0,5],[0,0]],[[6,1],[7,1],[7,2],[6,2],[6,1]]]}}]}`,
		},
		{
			name: "hole intersects shell",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[5,0],[5,5],[0,5],[0,0]],[[4,1],[6,1],[6,2],[4,2],[4,1]]]}}]}`,
		},
		{
			name: "holes intersect each other",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[8,0],[8,8],[0,8],[0,0]],[[1,1],[4,1],[4,4],[1,4],[1,1]],[[3,3],[6,3],[6,6],[3,6],[3,3]]]}}]}`,
		},
		{
			name: "nested holes are invalid",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[8,0],[8,8],[0,8],[0,0]],[[1,1],[7,1],[7,7],[1,7],[1,1]],[[2,2],[3,2],[3,3],[2,3],[2,2]]]}}]}`,
		},
		{
			name: "multipolygon with malformed position",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0]]],[[[0]]]]}}]}`,
		},
		{
			name: "overlapping multipolygon members are invalid",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[3,0],[3,3],[0,3],[0,0]]],[[[2,1],[4,1],[4,2],[2,2],[2,1]]]]}}]}`,
		},
		{
			name: "aligned overlapping multipolygon members are invalid",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[2,0],[2,1],[0,1],[0,0]]],[[[1,0],[3,0],[3,1],[1,1],[1,0]]]]}}]}`,
		},
		{
			name: "ultra thin aligned overlapping multipolygon members are invalid",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0,89],[2,89],[2,89.00000000000001],[0,89.00000000000001],[0,89]]],[[[1,89],[3,89],[3,89.00000000000001],[1,89.00000000000001],[1,89]]]]}}]}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := newTestAdminServer(t)
			req := httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewBufferString(test.body))
			recorder := httptest.NewRecorder()
			srv.handleAdminPutHashRegions(recorder, req)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestAdminHashRegionDefinitionsAcceptValidConcaveCollinearAndSmallRings(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			name: "concave ring",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[2,2],[0,4],[0,0]]]}}]}`,
		},
		{
			name: "adjacent collinear edges",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[2,0],[4,0],[4,4],[0,4],[0,0]]]}}]}`,
		},
		{
			name: "small nonzero ring",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[0.0000001,0],[0.0000001,0.0000001],[0,0.0000001],[0,0]]]}}]}`,
		},
		{
			name: "small nonzero ring with large offset",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[100,50],[100.0000001,50],[100.0000001,50.0000001],[100,50.0000001],[100,50]]]}}]}`,
		},
		{
			name: "multipolygon members sharing an edge",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[1,0],[2,0],[2,1],[1,1],[1,0]]]]}}]}`,
		},
		{
			name: "near collinear non crossing edges",
			body: `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0.0000000000005],[0,0]]]}}]}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := newTestAdminServer(t)
			recorder := httptest.NewRecorder()
			srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(test.body)))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
			}
		})
	}
}

func TestAdminHashRegionDefinitionsRejectExcessiveRingComplexity(t *testing.T) {
	positions := make([]string, 4097)
	for index := range positions {
		positions[index] = `[0,0]`
	}
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[[` + strings.Join(positions, ",") + `]]}}]}`
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "positions (max 4096)") {
		t.Fatalf("status = %d body = %s, want bounded-complexity error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectExcessiveRingCount(t *testing.T) {
	rings := make([]string, 258)
	rings[0] = `[[0,0],[10,0],[10,10],[0,10],[0,0]]`
	for index := 1; index < len(rings); index++ {
		rings[index] = `[[1,1],[2,1],[2,2],[1,2],[1,1]]`
	}
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[` + strings.Join(rings, ",") + `]}}]}`
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "rings (max 256)") {
		t.Fatalf("status = %d body = %s, want bounded-ring-count error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectExcessiveMultiPolygonMembers(t *testing.T) {
	members := make([]string, 257)
	for index := range members {
		members[index] = `[[[0,0],[1,0],[1,1],[0,1],[0,0]]]`
	}
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[` + strings.Join(members, ",") + `]}}]}`
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "members (max 256)") {
		t.Fatalf("status = %d body = %s, want bounded-member-count error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectExcessiveTotalPositions(t *testing.T) {
	ring := make([]string, 4095)
	for index := range ring {
		ring[index] = `[0,0]`
	}
	rings := make([]string, 5)
	for index := range rings {
		rings[index] = `[` + strings.Join(ring, ",") + `]`
	}
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[` + strings.Join(rings, ",") + `]}}]}`
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "total positions (max 16384)") {
		t.Fatalf("status = %d body = %s, want bounded-total-position error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectExcessiveValidationWork(t *testing.T) {
	ring := make([]string, 4095)
	for index := range ring {
		ring[index] = `[0,0]`
	}
	rings := make([]string, 3)
	for index := range rings {
		rings[index] = `[` + strings.Join(ring, ",") + `]`
	}
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"Polygon","coordinates":[` + strings.Join(rings, ",") + `]}}]}`
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "validation work limit") {
		t.Fatalf("status = %d body = %s, want validation-work limit error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectAggregateValidationWork(t *testing.T) {
	ring := make([][]float64, 0, 4001)
	for side := 0; side < 4; side++ {
		for step := 0; step < 1000; step++ {
			fraction := float64(step) / 1000
			switch side {
			case 0:
				ring = append(ring, []float64{fraction, 0})
			case 1:
				ring = append(ring, []float64{1, fraction})
			case 2:
				ring = append(ring, []float64{1 - fraction, 1})
			case 3:
				ring = append(ring, []float64{0, 1 - fraction})
			}
		}
	}
	ring = append(ring, ring[0])
	definitions := make([]map[string]any, 3)
	for index := range definitions {
		definitionRing := ring
		if index == len(definitions)-1 {
			definitionRing = append([][]float64(nil), ring...)
			definitionRing[1500] = []float64{-1, 0.5}
		}
		definitions[index] = map[string]any{
			"name":     fmt.Sprintf("#complex-%d", index),
			"geometry": map[string]any{"type": "Polygon", "coordinates": []any{definitionRing}},
		}
	}
	body, err := json.Marshal(map[string]any{"hashRegionDefinitions": definitions})
	if err != nil {
		t.Fatal(err)
	}
	if len(body) >= 1<<20 {
		t.Fatalf("fixture is %d bytes, want under request limit", len(body))
	}
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(body)))
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "request validation work limit") {
		t.Fatalf("status = %d body = %s, want aggregate validation-work limit error", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsDoNotRevalidateUnchangedStoredGeometry(t *testing.T) {
	largeRing := make([][]float64, 0, 4001)
	for side := 0; side < 4; side++ {
		for step := 0; step < 1000; step++ {
			fraction := float64(step) / 1000
			switch side {
			case 0:
				largeRing = append(largeRing, []float64{fraction, 0})
			case 1:
				largeRing = append(largeRing, []float64{1, fraction})
			case 2:
				largeRing = append(largeRing, []float64{1 - fraction, 1})
			case 3:
				largeRing = append(largeRing, []float64{0, 1 - fraction})
			}
		}
	}
	largeRing = append(largeRing, largeRing[0])
	largeGeometry := map[string]any{"type": "Polygon", "coordinates": []any{largeRing}}
	definitions := []any{
		map[string]any{"name": "#large-a", "geometry": largeGeometry},
		map[string]any{"name": "#large-b", "geometry": largeGeometry},
	}

	srv := newTestAdminServer(t)
	initialBody, err := json.Marshal(map[string]any{"hashRegionDefinitions": definitions})
	if err != nil {
		t.Fatal(err)
	}
	initialRecorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(initialRecorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(initialBody)))
	if initialRecorder.Code != http.StatusOK {
		t.Fatalf("initial status = %d, want 200: %s", initialRecorder.Code, initialRecorder.Body.String())
	}

	smallRing := make([][]float64, 0, 501)
	for side := 0; side < 4; side++ {
		for step := 0; step < 125; step++ {
			fraction := float64(step) / 125
			switch side {
			case 0:
				smallRing = append(smallRing, []float64{2 + fraction, 0})
			case 1:
				smallRing = append(smallRing, []float64{3, fraction})
			case 2:
				smallRing = append(smallRing, []float64{3 - fraction, 1})
			case 3:
				smallRing = append(smallRing, []float64{2, 1 - fraction})
			}
		}
	}
	smallRing = append(smallRing, smallRing[0])
	definitions = append(definitions, map[string]any{
		"name": "#small-new", "geometry": map[string]any{"type": "Polygon", "coordinates": []any{smallRing}},
	})
	updatedBody, err := json.Marshal(map[string]any{"hashRegionDefinitions": definitions})
	if err != nil {
		t.Fatal(err)
	}
	updatedRecorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(updatedRecorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(updatedBody)))
	if updatedRecorder.Code != http.StatusOK {
		t.Fatalf("updated status = %d, want 200 when existing geometries are unchanged: %s", updatedRecorder.Code, updatedRecorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsAcceptBundledCountyMultiPolygon(t *testing.T) {
	data, err := os.ReadFile("../../public/geo/tn-counties.geojson")
	if err != nil {
		t.Fatal(err)
	}
	var collection struct {
		Features []struct {
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
		} `json:"features"`
	}
	if err := json.Unmarshal(data, &collection); err != nil {
		t.Fatal(err)
	}
	var members [][][][]float64
	for _, feature := range collection.Features {
		switch feature.Geometry.Type {
		case "Polygon":
			var polygon [][][]float64
			if err := json.Unmarshal(feature.Geometry.Coordinates, &polygon); err != nil {
				t.Fatal(err)
			}
			members = append(members, polygon)
		case "MultiPolygon":
			var polygons [][][][]float64
			if err := json.Unmarshal(feature.Geometry.Coordinates, &polygons); err != nil {
				t.Fatal(err)
			}
			members = append(members, polygons...)
		}
	}
	body, err := json.Marshal(map[string]any{"hashRegionDefinitions": []any{map[string]any{
		"name": "#tn-counties", "geometry": map[string]any{"type": "MultiPolygon", "coordinates": members},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	srv := newTestAdminServer(t)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for bundled county geometry: %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRoundTrip(t *testing.T) {
	srv := newTestAdminServer(t)
	body := []byte(`{
		"hashRegionDefinitions": [
			{
				"name": "us-tn",
				"description": "Tennessee regional scope",
				"geometry": {"type":"Polygon","coordinates":[[[-90,35],[-81,35],[-81,37],[-90,35]]]}
			},
			{
				"name": "#us-tn-bna",
				"parentName": "us-tn",
				"description": "Middle Tennessee and Nashville",
				"geometry": {"type":"MultiPolygon","coordinates":[[[[-88,35],[-85,35],[-85,37],[-88,35]]]]}
			}
		]
	}`)

	putReq := httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", bytes.NewReader(body))
	putRecorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(putRecorder, putReq)
	if putRecorder.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200: %s", putRecorder.Code, putRecorder.Body.String())
	}

	getReq := httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions", nil)
	getRecorder := httptest.NewRecorder()
	srv.handleAdminGetHashRegions(getRecorder, getReq)
	if getRecorder.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200: %s", getRecorder.Code, getRecorder.Body.String())
	}

	var response struct {
		HashRegions []string `json:"hashRegions"`
		Definitions []struct {
			Name        string          `json:"name"`
			ParentName  string          `json:"parentName"`
			Description string          `json:"description"`
			Geometry    json.RawMessage `json:"geometry"`
		} `json:"hashRegionDefinitions"`
	}
	if err := json.Unmarshal(getRecorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode GET response: %v", err)
	}
	if len(response.HashRegions) != 2 || response.HashRegions[0] != "#us-tn" || response.HashRegions[1] != "#us-tn-bna" {
		t.Fatalf("hashRegions = %v, want normalized names", response.HashRegions)
	}
	if len(response.Definitions) != 2 {
		t.Fatalf("hashRegionDefinitions = %#v, want 2 entries", response.Definitions)
	}
	if got := response.Definitions[1]; got.ParentName != "#us-tn" || got.Description != "Middle Tennessee and Nashville" {
		t.Fatalf("child definition = %#v, want normalized parent and description", got)
	}
	var geometry struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(response.Definitions[0].Geometry, &geometry); err != nil {
		t.Fatalf("decode geometry: %v", err)
	}
	if geometry.Type != "Polygon" {
		t.Fatalf("geometry type = %q, want Polygon", geometry.Type)
	}
}

func TestAdminHashRegionDefinitionsPreserveValidHolesAndMultiPolygons(t *testing.T) {
	srv := newTestAdminServer(t)
	body := `{"hashRegionDefinitions":[{"name":"#a","geometry":{"type":"MultiPolygon","coordinates":[[[[0,0],[8,0],[8,8],[0,8],[0,0]],[[1,1],[2,1],[2,2],[1,2],[1,1]]],[[[20,20],[22,20],[22,22],[20,22],[20,20]]]]}}]}`
	put := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(put, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if put.Code != http.StatusOK {
		t.Fatalf("PUT status = %d, want 200: %s", put.Code, put.Body.String())
	}
	get := httptest.NewRecorder()
	srv.handleAdminGetHashRegions(get, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200: %s", get.Code, get.Body.String())
	}
	var response hashRegionDefinitionsResponse
	if err := json.Unmarshal(get.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	var geometry struct {
		Type        string          `json:"type"`
		Coordinates [][][][]float64 `json:"coordinates"`
	}
	if err := json.Unmarshal(response.HashRegionDefinitions[0].Geometry, &geometry); err != nil {
		t.Fatal(err)
	}
	if geometry.Type != "MultiPolygon" || len(geometry.Coordinates) != 2 || len(geometry.Coordinates[0]) != 2 {
		t.Fatalf("geometry lost polygon members or holes: %#v", geometry)
	}
}

func TestAdminHashRegionDefinitionsBodyOverflowReturns413(t *testing.T) {
	srv := newTestAdminServer(t)
	body := `{"hashRegionDefinitions":[],"padding":"` + strings.Repeat("x", (1<<20)+1) + `"}`
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "1 MiB") {
		t.Fatalf("body = %q, want explicit size limit", recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectTrailingOversizeData(t *testing.T) {
	srv := newTestAdminServer(t)
	body := `{"hashRegionDefinitions":[]}` + strings.Repeat(" ", (1<<20)+1)
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413: %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminHashRegionDefinitionsRejectTrailingJSONValue(t *testing.T) {
	srv := newTestAdminServer(t)
	body := `{"hashRegionDefinitions":[]} {"unexpected":true}`
	recorder := httptest.NewRecorder()
	srv.handleAdminPutHashRegions(recorder, httptest.NewRequest(http.MethodPut, "/api/admin/hash-regions", strings.NewReader(body)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
}

func TestConfigHashRegionDefinitionsStorageErrorReturns5xxJSON(t *testing.T) {
	srv := newTestAdminServer(t)
	if err := srv.admin.Close(); err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	srv.handleConfigHashRegionDefinitions(recorder, httptest.NewRequest(http.MethodGet, "/api/config/hash-region-definitions", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500: %s", recorder.Code, recorder.Body.String())
	}
	if contentType := recorder.Header().Get("Content-Type"); !strings.Contains(contentType, "application/json") {
		t.Fatalf("Content-Type = %q, want JSON", contentType)
	}
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body.Error == "" {
		t.Fatalf("body = %q, want JSON error", recorder.Body.String())
	}
}
