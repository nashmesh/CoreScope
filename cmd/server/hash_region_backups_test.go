package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/meshcore-analyzer/admindb"
)

func TestAdminHashRegionBackupTrustedLegacyNullImportPreservesSaved(t *testing.T) {
	for _, test := range nonNumericHashRegionGeometries() {
		if !strings.Contains(test.geometry, "null") {
			continue
		}
		for _, mode := range []string{"merge", "replace"} {
			for _, dryRun := range []bool{true, false} {
				t.Run(fmt.Sprintf("%s/%s/dryRun=%t", test.name, mode, dryRun), func(t *testing.T) {
					srv := newTestAdminServer(t)
					saved := []admindb.HashRegionDefinition{
						{Name: "#child", ParentName: "#legacy", Description: "retain hierarchy"},
						{Name: "#legacy", Description: "retain metadata", Color: "#123456", GeometryJSON: test.geometry},
					}
					if err := srv.admin.ReplaceHashRegionDefinitions(saved); err != nil {
						t.Fatal(err)
					}
					export := httptest.NewRecorder()
					srv.handleAdminExportHashRegions(export, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions/export", nil))
					if export.Code != http.StatusOK {
						t.Fatalf("legacy backup export = %d: %s", export.Code, export.Body.String())
					}
					var backup hashRegionBackupEnvelope
					if err := json.Unmarshal(export.Body.Bytes(), &backup); err != nil {
						t.Fatal(err)
					}
					if len(backup.HashRegionDefinitions) != 2 || string(backup.HashRegionDefinitions[1].Geometry) != test.geometry {
						t.Fatalf("export did not retain legacy geometry: %#v", backup)
					}
					// Resubmit the exported geometry, but ensure acceptance would mutate state.
					backup.HashRegionDefinitions[1].Description = "must not import"
					body, err := json.Marshal(backup)
					if err != nil {
						t.Fatal(err)
					}
					revision, err := hashRegionDefinitionsRevision(saved)
					if err != nil {
						t.Fatal(err)
					}
					requestURL := fmt.Sprintf("/api/admin/hash-regions/import?mode=%s&confirm=true&dryRun=%t&expectedRevision=%s", mode, dryRun, url.QueryEscape(revision))
					recorder := httptest.NewRecorder()
					srv.handleAdminImportHashRegions(recorder, httptest.NewRequest(http.MethodPost, requestURL, strings.NewReader(string(body))))
					if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "null") {
						t.Errorf("legacy null import = %d, want numeric rejection: %s", recorder.Code, recorder.Body.String())
					}
					after, err := srv.admin.ListHashRegionDefinitions()
					if err != nil {
						t.Fatal(err)
					}
					if !reflect.DeepEqual(after, saved) {
						t.Errorf("legacy null import changed persisted state: got %#v want %#v", after, saved)
					}
				})
			}
		}
	}
}

func TestAdminHashRegionBackupExportIsDeterministicAndComplete(t *testing.T) {
	srv := newTestAdminServer(t)
	definitions := []admindb.HashRegionDefinition{
		{
			Name:         "#z-child",
			ParentName:   "#a-root",
			Description:  "Child metadata",
			Color:        "#abcdef",
			GeometryJSON: `{"type":"MultiPolygon","coordinates":[[[[2,2],[3,2],[3,3],[2,2]]]]}`,
		},
		{
			Name:         "#a-root",
			Description:  "Root metadata",
			Color:        "#123456",
			GeometryJSON: `{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}`,
		},
	}
	if err := srv.admin.ReplaceHashRegionDefinitions(definitions); err != nil {
		t.Fatal(err)
	}

	export := func() *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		srv.handleAdminExportHashRegions(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions/export", nil))
		return recorder
	}
	first := export()
	second := export()
	if first.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", first.Code, first.Body.String())
	}
	if first.Body.String() != second.Body.String() {
		t.Fatalf("successive exports differ:\nfirst: %s\nsecond: %s", first.Body.String(), second.Body.String())
	}
	if got := first.Header().Get("Content-Disposition"); got != `attachment; filename="corescope-hash-regions-v1.json"` {
		t.Fatalf("Content-Disposition = %q", got)
	}
	if got := first.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}

	var backup hashRegionBackupEnvelope
	if err := json.Unmarshal(first.Body.Bytes(), &backup); err != nil {
		t.Fatalf("decode export: %v", err)
	}
	if backup.Kind != hashRegionBackupKind || backup.SchemaVersion != hashRegionBackupSchemaVersion {
		t.Fatalf("backup identity = %#v", backup)
	}
	if len(backup.HashRegionDefinitions) != 2 {
		t.Fatalf("definitions = %#v, want 2", backup.HashRegionDefinitions)
	}
	if got := backup.HashRegionDefinitions[0]; got.Name != "#a-root" || got.Description != "Root metadata" || got.Color != "#123456" || len(got.Geometry) == 0 {
		t.Fatalf("root definition = %#v, want all persisted fields in alphabetical order", got)
	}
	if got := backup.HashRegionDefinitions[1]; got.Name != "#z-child" || got.ParentName != "#a-root" || got.Description != "Child metadata" || got.Color != "#abcdef" || len(got.Geometry) == 0 {
		t.Fatalf("child definition = %#v, want all persisted fields", got)
	}
}

func TestAdminHashRegionBackupImportDefaultsToMergeAndReplaceRequiresConfirmation(t *testing.T) {
	srv := newTestAdminServer(t)
	existing := []admindb.HashRegionDefinition{
		{Name: "#keep", Description: "preserved"},
		{Name: "#update", Description: "old"},
	}
	if err := srv.admin.ReplaceHashRegionDefinitions(existing); err != nil {
		t.Fatal(err)
	}

	backup := `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"update","description":"new","color":"#ABCDEF","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}]}`
	dryRun := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(dryRun, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?mode=replace&dryRun=true", strings.NewReader(backup)))
	if dryRun.Code != http.StatusOK {
		t.Fatalf("replace dry-run status = %d, want 200: %s", dryRun.Code, dryRun.Body.String())
	}
	var preview hashRegionBackupImportResponse
	if err := json.Unmarshal(dryRun.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if !preview.DryRun || preview.Mode != "replace" || preview.Updated != 1 || preview.Removed != 1 || preview.Total != 1 || preview.Revision == "" {
		t.Fatalf("replace dry-run preview = %#v", preview)
	}
	got, err := srv.admin.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Description != "preserved" || got[1].Description != "old" {
		t.Fatalf("replace dry-run mutated definitions: %#v", got)
	}

	missingRevision := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(missingRevision, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import", strings.NewReader(backup)))
	if missingRevision.Code != http.StatusBadRequest {
		t.Fatalf("apply without dry-run revision status = %d, want 400: %s", missingRevision.Code, missingRevision.Body.String())
	}

	merge := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(merge, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?expectedRevision="+url.QueryEscape(preview.Revision), strings.NewReader(backup)))
	if merge.Code != http.StatusOK {
		t.Fatalf("merge status = %d, want 200: %s", merge.Code, merge.Body.String())
	}
	got, err = srv.admin.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Name != "#keep" || got[0].Description != "preserved" || got[1].Name != "#update" || got[1].Description != "new" || got[1].Color != "#abcdef" || got[1].GeometryJSON == "" {
		t.Fatalf("merged definitions = %#v", got)
	}

	unconfirmed := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(unconfirmed, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?mode=replace", strings.NewReader(backup)))
	if unconfirmed.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed replace status = %d, want 400: %s", unconfirmed.Code, unconfirmed.Body.String())
	}
	got, err = srv.admin.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("unconfirmed replace mutated definitions: %#v", got)
	}

	replaceDryRun := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(replaceDryRun, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?mode=replace&dryRun=true", strings.NewReader(backup)))
	if replaceDryRun.Code != http.StatusOK {
		t.Fatalf("second replace dry-run status = %d, want 200: %s", replaceDryRun.Code, replaceDryRun.Body.String())
	}
	if err := json.Unmarshal(replaceDryRun.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	replace := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(replace, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?mode=replace&confirm=true&expectedRevision="+url.QueryEscape(preview.Revision), strings.NewReader(backup)))
	if replace.Code != http.StatusOK {
		t.Fatalf("replace status = %d, want 200: %s", replace.Code, replace.Body.String())
	}
	got, err = srv.admin.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Name != "#update" || got[0].Description != "new" {
		t.Fatalf("replaced definitions = %#v", got)
	}
}

func TestAdminHashRegionBackupImportRejectsChangesAfterPreview(t *testing.T) {
	srv := newTestAdminServer(t)
	initial := []admindb.HashRegionDefinition{{Name: "#keep", Description: "original"}}
	if err := srv.admin.ReplaceHashRegionDefinitions(initial); err != nil {
		t.Fatal(err)
	}
	backup := `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#keep","description":"imported"}]}`
	previewRecorder := httptest.NewRecorder()
	srv.handleAdminImportHashRegions(previewRecorder, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?dryRun=true", strings.NewReader(backup)))
	if previewRecorder.Code != http.StatusOK {
		t.Fatalf("dry-run status = %d, want 200: %s", previewRecorder.Code, previewRecorder.Body.String())
	}
	var preview hashRegionBackupImportResponse
	if err := json.Unmarshal(previewRecorder.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	concurrent := []admindb.HashRegionDefinition{
		{Name: "#added", Description: "concurrent add"},
		{Name: "#keep", Description: "concurrent edit"},
	}
	if err := srv.admin.ReplaceHashRegionDefinitions(concurrent); err != nil {
		t.Fatal(err)
	}
	applyRecorder := httptest.NewRecorder()
	applyURL := "/api/admin/hash-regions/import?expectedRevision=" + url.QueryEscape(preview.Revision)
	srv.handleAdminImportHashRegions(applyRecorder, httptest.NewRequest(http.MethodPost, applyURL, strings.NewReader(backup)))
	if applyRecorder.Code != http.StatusConflict {
		t.Fatalf("stale apply status = %d, want 409: %s", applyRecorder.Code, applyRecorder.Body.String())
	}
	got, err := srv.admin.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, concurrent) {
		t.Fatalf("stale apply overwrote concurrent definitions: got %#v want %#v", got, concurrent)
	}
}

func TestAdminHashRegionBackupRoutesRequireAuthAndCSRF(t *testing.T) {
	srv := newTestAdminServer(t)
	exportHandler := srv.requireAdmin(http.HandlerFunc(srv.handleAdminExportHashRegions))
	importHandler := srv.requireAdmin(srv.requireCSRF(http.HandlerFunc(srv.handleAdminImportHashRegions)))

	unauthExport := httptest.NewRecorder()
	exportHandler.ServeHTTP(unauthExport, httptest.NewRequest(http.MethodGet, "/api/admin/hash-regions/export", nil))
	if unauthExport.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated export status = %d, want 401", unauthExport.Code)
	}
	backup := `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[]}`
	unauthImport := httptest.NewRecorder()
	importHandler.ServeHTTP(unauthImport, httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import", strings.NewReader(backup)))
	if unauthImport.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated import status = %d, want 401", unauthImport.Code)
	}

	if _, err := srv.admin.CreateAdmin("backup-admin", "correct horse battery staple", admindb.RoleAdmin, nil); err != nil {
		t.Fatal(err)
	}
	login := doLogin(t, srv, "backup-admin", "correct horse battery staple")
	session := sessionCookie(t, login)
	csrf := csrfCookie(t, login)

	missingCSRF := httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import", strings.NewReader(backup))
	missingCSRF.AddCookie(session)
	missingCSRFRecorder := httptest.NewRecorder()
	importHandler.ServeHTTP(missingCSRFRecorder, missingCSRF)
	if missingCSRFRecorder.Code != http.StatusForbidden {
		t.Fatalf("import without CSRF status = %d, want 403", missingCSRFRecorder.Code)
	}

	authorized := httptest.NewRequest(http.MethodPost, "/api/admin/hash-regions/import?dryRun=true", strings.NewReader(backup))
	authorized.AddCookie(session)
	authorized.AddCookie(csrf)
	authorized.Header.Set("X-CSRF-Token", csrf.Value)
	authorizedRecorder := httptest.NewRecorder()
	importHandler.ServeHTTP(authorizedRecorder, authorized)
	if authorizedRecorder.Code != http.StatusOK {
		t.Fatalf("authenticated CSRF import status = %d, want 200: %s", authorizedRecorder.Code, authorizedRecorder.Body.String())
	}
}

func TestAdminHashRegionBackupImportRejectsInvalidBackupWithoutMutation(t *testing.T) {
	tooMany := make([]string, maxHashRegionEntries+1)
	for index := range tooMany {
		tooMany[index] = `{"name":"#region-` + fmt.Sprint(index) + `"}`
	}
	tests := []struct {
		name string
		url  string
		body string
	}{
		{name: "malformed JSON", body: `{`},
		{name: "trailing JSON", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[]} {}`},
		{name: "wrong kind", body: `{"kind":"other","schemaVersion":1,"hashRegionDefinitions":[]}`},
		{name: "incompatible schema", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":2,"hashRegionDefinitions":[]}`},
		{name: "missing definitions", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1}`},
		{name: "unknown envelope field", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[],"unsafe":true}`},
		{name: "unknown definition field", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#new","unsafe":true}]}`},
		{name: "duplicate normalized names", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"new"},{"name":"#new"}]}`},
		{name: "bad parent", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#new","parentName":"#missing"}]}`},
		{name: "parent cycle", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#a","parentName":"#b"},{"name":"#b","parentName":"#a"}]}`},
		{name: "invalid color", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#new","color":"red"}]}`},
		{name: "invalid geometry", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#new","geometry":{"type":"LineString","coordinates":[[0,0],[1,1]]}}]}`},
		{name: "unknown geometry field", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[{"name":"#new","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]],"script":"unsafe"}}]}`},
		{name: "entry limit", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[` + strings.Join(tooMany, ",") + `]}`},
		{name: "unknown mode", url: "?mode=append", body: `{"kind":"corescope.hash-region-definitions","schemaVersion":1,"hashRegionDefinitions":[]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			srv := newTestAdminServer(t)
			before := []admindb.HashRegionDefinition{{Name: "#existing", Description: "must survive"}}
			if err := srv.admin.ReplaceHashRegionDefinitions(before); err != nil {
				t.Fatal(err)
			}
			recorder := httptest.NewRecorder()
			requestURL := "/api/admin/hash-regions/import?dryRun=true"
			if test.url != "" {
				requestURL += "&" + strings.TrimPrefix(test.url, "?")
			}
			req := httptest.NewRequest(http.MethodPost, requestURL, strings.NewReader(test.body))
			srv.handleAdminImportHashRegions(recorder, req)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
			}
			after, err := srv.admin.ListHashRegionDefinitions()
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, before) {
				t.Fatalf("invalid import mutated definitions: got %#v want %#v", after, before)
			}
		})
	}
}
