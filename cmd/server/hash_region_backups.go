package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/meshcore-analyzer/admindb"
)

const (
	hashRegionBackupKind          = "corescope.hash-region-definitions"
	hashRegionBackupSchemaVersion = 1
)

type hashRegionBackupEnvelope struct {
	Kind                  string                        `json:"kind"`
	SchemaVersion         int                           `json:"schemaVersion"`
	HashRegionDefinitions []hashRegionDefinitionPayload `json:"hashRegionDefinitions"`
}

type hashRegionBackupImportResponse struct {
	Mode      string `json:"mode"`
	DryRun    bool   `json:"dryRun"`
	Imported  int    `json:"imported"`
	Total     int    `json:"total"`
	Added     int    `json:"added"`
	Updated   int    `json:"updated"`
	Preserved int    `json:"preserved"`
	Removed   int    `json:"removed"`
	Revision  string `json:"revision"`
}

func (s *Server) handleAdminExportHashRegions(w http.ResponseWriter, r *http.Request) {
	definitions, err := s.admin.ListHashRegionDefinitions()
	if err != nil {
		log.Printf("[hash-regions] export load failed: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to export hash regions")
		return
	}
	payloads, err := hashRegionDefinitionPayloads(definitions)
	if err != nil {
		log.Printf("[hash-regions] export invalid stored definitions: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to export hash regions")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="corescope-hash-regions-v1.json"`)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if err := json.NewEncoder(w).Encode(hashRegionBackupEnvelope{
		Kind:                  hashRegionBackupKind,
		SchemaVersion:         hashRegionBackupSchemaVersion,
		HashRegionDefinitions: payloads,
	}); err != nil {
		log.Printf("[hash-regions] export encode failed: %v", err)
	}
}

func (s *Server) handleAdminImportHashRegions(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "replace" {
		writeError(w, http.StatusBadRequest, "import mode must be merge or replace")
		return
	}
	dryRun := r.URL.Query().Get("dryRun") == "true"
	if raw := r.URL.Query().Get("dryRun"); raw != "" && raw != "true" && raw != "false" {
		writeError(w, http.StatusBadRequest, "dryRun must be true or false")
		return
	}
	if mode == "replace" && !dryRun && r.URL.Query().Get("confirm") != "true" {
		writeError(w, http.StatusBadRequest, "replace import requires explicit confirmation")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var backup hashRegionBackupEnvelope
	if err := decoder.Decode(&backup); err != nil {
		writeHashRegionBackupDecodeError(w, err)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if maxErr := (*http.MaxBytesError)(nil); errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "backup exceeds 1 MiB limit")
			return
		}
		writeError(w, http.StatusBadRequest, "backup must contain exactly one JSON value")
		return
	}
	if backup.Kind != hashRegionBackupKind {
		writeError(w, http.StatusBadRequest, "unsupported hash-region backup kind")
		return
	}
	if backup.SchemaVersion != hashRegionBackupSchemaVersion {
		writeError(w, http.StatusBadRequest, "unsupported hash-region backup schema version")
		return
	}
	if backup.HashRegionDefinitions == nil {
		writeError(w, http.StatusBadRequest, "hashRegionDefinitions is required")
		return
	}

	stored, err := s.admin.ListHashRegionDefinitions()
	if err != nil {
		log.Printf("[hash-regions] import load failed: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to read existing hash regions")
		return
	}
	revision, err := hashRegionDefinitionsRevision(stored)
	if err != nil {
		log.Printf("[hash-regions] import revision failed: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to read existing hash regions")
		return
	}
	if !dryRun {
		expectedRevision := r.URL.Query().Get("expectedRevision")
		if expectedRevision == "" {
			writeError(w, http.StatusBadRequest, "import requires a current dry-run revision")
			return
		}
		if expectedRevision != revision {
			writeError(w, http.StatusConflict, "hash regions changed after backup validation; validate the backup again")
			return
		}
	}
	candidate := backup.HashRegionDefinitions
	storedNames := make(map[string]bool, len(stored))
	for _, definition := range stored {
		storedNames[definition.Name] = true
	}
	incomingNames := make(map[string]bool, len(backup.HashRegionDefinitions))
	added, updated := 0, 0
	for _, definition := range backup.HashRegionDefinitions {
		name := normalizeHashRegionName(definition.Name)
		incomingNames[name] = true
		if storedNames[name] {
			updated++
		} else {
			added++
		}
	}
	if mode == "merge" {
		candidate = make([]hashRegionDefinitionPayload, 0, len(stored)+len(backup.HashRegionDefinitions))
		storedPayloads, err := hashRegionDefinitionPayloads(stored)
		if err != nil {
			log.Printf("[hash-regions] import invalid stored definitions: %v", err)
			writeError(w, http.StatusInternalServerError, "failed to read existing hash regions")
			return
		}
		for _, definition := range storedPayloads {
			if !incomingNames[definition.Name] {
				candidate = append(candidate, definition)
			}
		}
		candidate = append(candidate, backup.HashRegionDefinitions...)
	}

	definitions, err := cleanHashRegionDefinitionsWithTrusted(candidate, stored)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	preserved, removed := 0, 0
	for name := range storedNames {
		if !incomingNames[name] {
			if mode == "merge" {
				preserved++
			} else {
				removed++
			}
		}
	}
	response := hashRegionBackupImportResponse{
		Mode: mode, DryRun: dryRun, Imported: len(backup.HashRegionDefinitions), Total: len(definitions),
		Added: added, Updated: updated, Preserved: preserved, Removed: removed, Revision: revision,
	}
	if dryRun {
		writeJSON(w, response)
		return
	}
	if err := s.admin.ReplaceHashRegionDefinitionsIfUnchanged(definitions, stored); err != nil {
		if errors.Is(err, admindb.ErrHashRegionDefinitionsChanged) {
			writeError(w, http.StatusConflict, "hash regions changed during import; validate the backup again")
			return
		}
		log.Printf("[hash-regions] import save failed: %v", err)
		writeError(w, http.StatusInternalServerError, "failed to import hash regions")
		return
	}
	writeJSON(w, response)
}

func hashRegionDefinitionsRevision(definitions []admindb.HashRegionDefinition) (string, error) {
	payloads, err := hashRegionDefinitionPayloads(definitions)
	if err != nil {
		return "", err
	}
	encoded, err := json.Marshal(payloads)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return fmt.Sprintf("%x", sum), nil
}

func writeHashRegionBackupDecodeError(w http.ResponseWriter, err error) {
	if maxErr := (*http.MaxBytesError)(nil); errors.As(err, &maxErr) {
		writeError(w, http.StatusRequestEntityTooLarge, "backup exceeds 1 MiB limit")
		return
	}
	writeError(w, http.StatusBadRequest, "invalid hash-region backup JSON: "+err.Error())
}
