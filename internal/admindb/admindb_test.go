package admindb

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(filepath.Join(dir, "admin.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestCreateAndAuthenticateAdmin(t *testing.T) {
	s := openTestStore(t)

	a, err := s.CreateAdmin("alice", "correct horse battery staple", RoleSuperAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if a.ID == 0 || a.Username != "alice" || a.Role != RoleSuperAdmin {
		t.Fatalf("unexpected admin: %+v", a)
	}

	got, err := s.Authenticate("alice", "correct horse battery staple")
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if got.ID != a.ID || got.Role != RoleSuperAdmin {
		t.Fatalf("unexpected authenticated admin: %+v", got)
	}

	// Case-insensitive username lookup (COLLATE NOCASE).
	if _, err := s.Authenticate("ALICE", "correct horse battery staple"); err != nil {
		t.Fatalf("case-insensitive Authenticate: %v", err)
	}
}

func TestAuthenticateWrongPassword(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.CreateAdmin("bob", "hunter2000", RoleAdmin, nil); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if _, err := s.Authenticate("bob", "wrong password"); err != ErrInvalidCredentials {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
}

func TestAuthenticateUnknownUsername(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.Authenticate("nobody", "whatever"); err != ErrInvalidCredentials {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
}

func TestAuthenticateDisabledAdmin(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("carol", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if _, err := s.db.Exec(`UPDATE admins SET disabled = 1 WHERE id = ?`, a.ID); err != nil {
		t.Fatalf("disable admin: %v", err)
	}
	if _, err := s.Authenticate("carol", "password12345"); err != ErrInvalidCredentials {
		t.Fatalf("got %v, want ErrInvalidCredentials for disabled admin", err)
	}
}

func TestCreateAdminDuplicateUsername(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.CreateAdmin("dave", "password12345", RoleAdmin, nil); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if _, err := s.CreateAdmin("dave", "another-password", RoleAdmin, nil); err != ErrUsernameTaken {
		t.Fatalf("got %v, want ErrUsernameTaken", err)
	}
	// Case-insensitive collision too.
	if _, err := s.CreateAdmin("DAVE", "another-password", RoleAdmin, nil); err != ErrUsernameTaken {
		t.Fatalf("got %v, want ErrUsernameTaken (case-insensitive)", err)
	}
}

func TestCreateAdminInvalidRole(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.CreateAdmin("erin", "password12345", Role("owner"), nil); err == nil {
		t.Fatal("expected error for invalid role")
	}
}

func TestCreateAdminEnforcesPasswordPolicy(t *testing.T) {
	s := openTestStore(t)

	if _, err := s.CreateAdmin("short-password", "short", RoleAdmin, nil); !errors.Is(err, ErrPasswordTooShort) {
		t.Fatalf("short password: got %v, want ErrPasswordTooShort", err)
	}
	if _, err := s.CreateAdmin("short-unicode-password", strings.Repeat("é", 4), RoleAdmin, nil); !errors.Is(err, ErrPasswordTooShort) {
		t.Fatalf("short Unicode password: got %v, want ErrPasswordTooShort", err)
	}
	if _, err := s.CreateAdmin("long-password", strings.Repeat("x", maxPasswordBytes+1), RoleAdmin, nil); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("long password: got %v, want ErrPasswordTooLong", err)
	}
	if _, err := s.CreateAdmin("boundary-password", strings.Repeat("x", minPasswordLen), RoleAdmin, nil); err != nil {
		t.Fatalf("minimum-length password should be accepted: %v", err)
	}
}

func TestInvalidCredentialHashMatchesConfiguredBCryptCost(t *testing.T) {
	cost, err := bcrypt.Cost([]byte(invalidCredentialHash))
	if err != nil {
		t.Fatalf("invalidCredentialHash is not a valid bcrypt hash: %v", err)
	}
	if cost != bcryptCost {
		t.Fatalf("invalidCredentialHash cost = %d, want %d", cost, bcryptCost)
	}
}

func TestCreateAdminRecordsCreatedBy(t *testing.T) {
	s := openTestStore(t)
	super, err := s.CreateAdmin("frank", "password12345", RoleSuperAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin super: %v", err)
	}
	created, err := s.CreateAdmin("grace", "password12345", RoleAdmin, &super.ID)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if created.CreatedBy == nil || *created.CreatedBy != super.ID {
		t.Fatalf("expected CreatedBy=%d, got %+v", super.ID, created.CreatedBy)
	}
}

func TestSessionCreateAndValidate(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("heidi", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	token, expiresAt, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if token == "" {
		t.Fatal("expected non-empty token")
	}
	if !expiresAt.After(time.Now()) {
		t.Fatalf("expected future expiry, got %v", expiresAt)
	}

	got, err := s.ValidateSession(token)
	if err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	if got.ID != a.ID {
		t.Fatalf("got admin id %d, want %d", got.ID, a.ID)
	}
}

func TestValidateSessionUnknownToken(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.ValidateSession("not-a-real-token"); err != ErrSessionInvalid {
		t.Fatalf("got %v, want ErrSessionInvalid", err)
	}
	if _, err := s.ValidateSession(""); err != ErrSessionInvalid {
		t.Fatalf("empty token: got %v, want ErrSessionInvalid", err)
	}
}

func TestValidateSessionExpired(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("ivan", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	token, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Force the session into the past directly, bypassing the TTL.
	past := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	if _, err := s.db.Exec(`UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?`, past, hashToken(token)); err != nil {
		t.Fatalf("force-expire session: %v", err)
	}
	if _, err := s.ValidateSession(token); err != ErrSessionInvalid {
		t.Fatalf("got %v, want ErrSessionInvalid", err)
	}
}

func TestValidateSessionSlidesExpiry(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("judy", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	token, firstExpiry, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	// Pull expires_at backward slightly so the post-validate slide is measurable.
	nudged := firstExpiry.Add(-time.Minute).Format(time.RFC3339)
	if _, err := s.db.Exec(`UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?`, nudged, hashToken(token)); err != nil {
		t.Fatalf("nudge expiry: %v", err)
	}
	if _, err := s.ValidateSession(token); err != nil {
		t.Fatalf("ValidateSession: %v", err)
	}
	var newExpiry string
	if err := s.db.QueryRow(`SELECT expires_at FROM admin_sessions WHERE token_hash = ?`, hashToken(token)).Scan(&newExpiry); err != nil {
		t.Fatalf("query expiry: %v", err)
	}
	got, err := time.Parse(time.RFC3339, newExpiry)
	if err != nil {
		t.Fatalf("parse expiry: %v", err)
	}
	if !got.After(firstExpiry.Add(-time.Minute)) {
		t.Fatalf("expected slid expiry after nudged value, got %v", got)
	}
}

func TestDeleteSession(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("kevin", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	token, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if err := s.DeleteSession(token); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, err := s.ValidateSession(token); err != ErrSessionInvalid {
		t.Fatalf("got %v, want ErrSessionInvalid after logout", err)
	}
	// Deleting an already-gone / unknown token is a no-op, not an error.
	if err := s.DeleteSession(token); err != nil {
		t.Fatalf("DeleteSession on missing token: %v", err)
	}
	if err := s.DeleteSession(""); err != nil {
		t.Fatalf("DeleteSession empty token: %v", err)
	}
}

func TestListAdmins(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.CreateAdmin("laura", "password12345", RoleSuperAdmin, nil); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if _, err := s.CreateAdmin("mallory", "password12345", RoleAdmin, nil); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	admins, err := s.ListAdmins()
	if err != nil {
		t.Fatalf("ListAdmins: %v", err)
	}
	if len(admins) != 2 {
		t.Fatalf("got %d admins, want 2", len(admins))
	}
	if admins[0].Username != "laura" || admins[1].Username != "mallory" {
		t.Fatalf("unexpected order/usernames: %+v", admins)
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "admin.db")
	s1, err := Open(path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	if _, err := s1.CreateAdmin("nina", "password12345", RoleSuperAdmin, nil); err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	s1.Close()

	s2, err := Open(path)
	if err != nil {
		t.Fatalf("second Open: %v", err)
	}
	defer s2.Close()
	admins, err := s2.ListAdmins()
	if err != nil {
		t.Fatalf("ListAdmins: %v", err)
	}
	if len(admins) != 1 || admins[0].Username != "nina" {
		t.Fatalf("expected data to survive reopen, got %+v", admins)
	}
}

func TestChangePasswordSuccess(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("oscar", "original-password", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if err := s.ChangePassword(a.ID, "original-password", "new-password-123"); err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}

	if _, err := s.Authenticate("oscar", "original-password"); err != ErrInvalidCredentials {
		t.Fatalf("old password should no longer work, got %v", err)
	}
	if _, err := s.Authenticate("oscar", "new-password-123"); err != nil {
		t.Fatalf("new password should work: %v", err)
	}
}

func TestChangePasswordWrongOldPassword(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("pat", "original-password", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if err := s.ChangePassword(a.ID, "wrong-old-password", "new-password-123"); err != ErrInvalidCredentials {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
	// Original password must still work — the change must not have applied.
	if _, err := s.Authenticate("pat", "original-password"); err != nil {
		t.Fatalf("original password should still work after a rejected change: %v", err)
	}
}

func TestChangePasswordTooShort(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("quinn", "original-password", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if err := s.ChangePassword(a.ID, "original-password", "short"); err != ErrPasswordTooShort {
		t.Fatalf("got %v, want ErrPasswordTooShort", err)
	}
	if _, err := s.Authenticate("quinn", "original-password"); err != nil {
		t.Fatalf("original password should still work after a rejected change: %v", err)
	}
}

func TestChangePasswordUnknownAdminID(t *testing.T) {
	s := openTestStore(t)
	if err := s.ChangePassword(999999, "whatever", "new-password-123"); err != ErrInvalidCredentials {
		t.Fatalf("got %v, want ErrInvalidCredentials", err)
	}
}

func TestChangePasswordTooLong(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("long-change", "original-password", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	if err := s.ChangePassword(a.ID, "original-password", strings.Repeat("x", maxPasswordBytes+1)); !errors.Is(err, ErrPasswordTooLong) {
		t.Fatalf("got %v, want ErrPasswordTooLong", err)
	}
}

func TestDeleteOtherSessionsKeepsCurrent(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("river", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	keepToken, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession (keep): %v", err)
	}
	otherToken, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession (other): %v", err)
	}

	if err := s.DeleteOtherSessions(a.ID, keepToken); err != nil {
		t.Fatalf("DeleteOtherSessions: %v", err)
	}

	if _, err := s.ValidateSession(keepToken); err != nil {
		t.Fatalf("kept session should still validate: %v", err)
	}
	if _, err := s.ValidateSession(otherToken); err != ErrSessionInvalid {
		t.Fatalf("other session should be invalidated, got %v", err)
	}
}

func TestDeleteOtherSessionsAllWhenKeepEmpty(t *testing.T) {
	s := openTestStore(t)
	a, err := s.CreateAdmin("sam", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin: %v", err)
	}
	tok1, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	tok2, _, err := s.CreateSession(a.ID)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if err := s.DeleteOtherSessions(a.ID, ""); err != nil {
		t.Fatalf("DeleteOtherSessions: %v", err)
	}
	if _, err := s.ValidateSession(tok1); err != ErrSessionInvalid {
		t.Fatalf("tok1 should be invalidated, got %v", err)
	}
	if _, err := s.ValidateSession(tok2); err != ErrSessionInvalid {
		t.Fatalf("tok2 should be invalidated, got %v", err)
	}
}

func TestDeleteOtherSessionsDoesNotAffectOtherAdmins(t *testing.T) {
	s := openTestStore(t)
	a1, err := s.CreateAdmin("tina", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin a1: %v", err)
	}
	a2, err := s.CreateAdmin("uma", "password12345", RoleAdmin, nil)
	if err != nil {
		t.Fatalf("CreateAdmin a2: %v", err)
	}
	a1Token, _, err := s.CreateSession(a1.ID)
	if err != nil {
		t.Fatalf("CreateSession a1: %v", err)
	}
	a2Token, _, err := s.CreateSession(a2.ID)
	if err != nil {
		t.Fatalf("CreateSession a2: %v", err)
	}

	if err := s.DeleteOtherSessions(a1.ID, ""); err != nil {
		t.Fatalf("DeleteOtherSessions: %v", err)
	}
	if _, err := s.ValidateSession(a1Token); err != ErrSessionInvalid {
		t.Fatalf("a1's session should be invalidated, got %v", err)
	}
	if _, err := s.ValidateSession(a2Token); err != nil {
		t.Fatalf("a2's session should be untouched: %v", err)
	}
}

func TestOpenUpgradesLegacyHashRegionSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "admin.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy DB: %v", err)
	}
	if _, err := legacy.Exec(`CREATE TABLE hash_regions (name TEXT PRIMARY KEY, created_at TEXT NOT NULL)`); err != nil {
		t.Fatalf("create legacy hash_regions: %v", err)
	}
	if _, err := legacy.Exec(`INSERT INTO hash_regions (name, created_at) VALUES ('#us-tn', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("seed legacy hash_regions: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy DB: %v", err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open legacy DB: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	definitions, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatalf("ListHashRegionDefinitions: %v", err)
	}
	want := HashRegionDefinition{Name: "#us-tn"}
	if len(definitions) != 1 || definitions[0] != want {
		t.Fatalf("definitions = %#v, want %#v", definitions, []HashRegionDefinition{want})
	}
}

func TestHashRegionDefinitionsReplaceAndList(t *testing.T) {
	s := openTestStore(t)

	definitions := []HashRegionDefinition{
		{
			Name:         "#us-tn",
			Color:        "#12abef",
			Description:  "Tennessee regional scope",
			GeometryJSON: `{"type":"Polygon","coordinates":[[[-90,35],[-81,35],[-81,37],[-90,35]]]}`,
		},
		{
			Name:         "#us-tn-bna",
			ParentName:   "#us-tn",
			Description:  "Middle Tennessee and Nashville",
			GeometryJSON: `{"type":"MultiPolygon","coordinates":[[[[-88,35],[-85,35],[-85,37],[-88,35]]]]}`,
		},
	}
	if err := s.ReplaceHashRegionDefinitions(definitions); err != nil {
		t.Fatalf("ReplaceHashRegionDefinitions: %v", err)
	}

	got, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatalf("ListHashRegionDefinitions: %v", err)
	}
	if len(got) != len(definitions) {
		t.Fatalf("ListHashRegionDefinitions returned %d rows, want %d: %#v", len(got), len(definitions), got)
	}
	for i := range definitions {
		if got[i] != definitions[i] {
			t.Fatalf("ListHashRegionDefinitions[%d] = %#v, want %#v", i, got[i], definitions[i])
		}
	}

	// The ingestor's legacy name-only view must remain compatible.
	names, err := s.ListHashRegions()
	if err != nil {
		t.Fatalf("ListHashRegions: %v", err)
	}
	if want := []string{"#us-tn", "#us-tn-bna"}; !stringSlicesEqual(names, want) {
		t.Fatalf("ListHashRegions = %v, want %v", names, want)
	}
}

func TestReplaceHashRegionDefinitionsIfUnchangedRejectsStaleWrite(t *testing.T) {
	s := openTestStore(t)
	initial := []HashRegionDefinition{{Name: "#keep", Description: "original"}}
	if err := s.ReplaceHashRegionDefinitions(initial); err != nil {
		t.Fatal(err)
	}
	expected, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	concurrent := []HashRegionDefinition{
		{Name: "#added", Description: "concurrent add"},
		{Name: "#keep", Description: "concurrent edit"},
	}
	if err := s.ReplaceHashRegionDefinitions(concurrent); err != nil {
		t.Fatal(err)
	}
	proposed := []HashRegionDefinition{{Name: "#keep", Description: "stale import"}}
	if err := s.ReplaceHashRegionDefinitionsIfUnchanged(proposed, expected); !errors.Is(err, ErrHashRegionDefinitionsChanged) {
		t.Fatalf("stale replacement error = %v, want ErrHashRegionDefinitionsChanged", err)
	}
	got, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if !hashRegionDefinitionsEqual(got, concurrent) {
		t.Fatalf("stale replacement overwrote concurrent definitions: got %#v want %#v", got, concurrent)
	}
	updated := []HashRegionDefinition{{Name: "#keep", Description: "fresh import"}}
	if err := s.ReplaceHashRegionDefinitionsIfUnchanged(updated, got); err != nil {
		t.Fatalf("fresh replacement failed: %v", err)
	}
	got, err = s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatal(err)
	}
	if !hashRegionDefinitionsEqual(got, updated) {
		t.Fatalf("fresh replacement = %#v, want %#v", got, updated)
	}
}

func TestReplaceHashRegionsClearsRemovedParentReference(t *testing.T) {
	s := openTestStore(t)
	definitions := []HashRegionDefinition{
		{Name: "#us-tn", Description: "Tennessee"},
		{Name: "#us-tn-bna", ParentName: "#us-tn", Description: "Middle Tennessee"},
	}
	if err := s.ReplaceHashRegionDefinitions(definitions); err != nil {
		t.Fatalf("ReplaceHashRegionDefinitions: %v", err)
	}
	if err := s.ReplaceHashRegions([]string{"#us-tn-bna"}); err != nil {
		t.Fatalf("ReplaceHashRegions: %v", err)
	}
	got, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatalf("ListHashRegionDefinitions: %v", err)
	}
	want := HashRegionDefinition{Name: "#us-tn-bna", Description: "Middle Tennessee"}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("definitions = %#v, want %#v", got, []HashRegionDefinition{want})
	}
}

func TestReplaceHashRegionsPreservesMetadataForRetainedNames(t *testing.T) {
	s := openTestStore(t)
	original := HashRegionDefinition{
		Name:         "#us-tn",
		Description:  "Tennessee regional scope",
		GeometryJSON: `{"type":"Polygon","coordinates":[[[-90,35],[-81,35],[-81,37],[-90,35]]]}`,
	}
	if err := s.ReplaceHashRegionDefinitions([]HashRegionDefinition{original}); err != nil {
		t.Fatalf("ReplaceHashRegionDefinitions: %v", err)
	}

	// The existing name-only admin UI uses ReplaceHashRegions. Retained names
	// must keep metadata while newly added names receive empty metadata.
	if err := s.ReplaceHashRegions([]string{"#us-tn", "#us-ky"}); err != nil {
		t.Fatalf("ReplaceHashRegions: %v", err)
	}
	got, err := s.ListHashRegionDefinitions()
	if err != nil {
		t.Fatalf("ListHashRegionDefinitions: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("definitions = %#v, want 2 entries", got)
	}
	if got[1] != original {
		t.Fatalf("retained definition = %#v, want %#v", got[1], original)
	}
	if got[0].Name != "#us-ky" || got[0].ParentName != "" || got[0].Description != "" || got[0].GeometryJSON != "" {
		t.Fatalf("new definition = %#v, want empty metadata", got[0])
	}
}

func TestHashRegionsReplaceAndList(t *testing.T) {
	s := openTestStore(t)

	// Empty initially.
	got, err := s.ListHashRegions()
	if err != nil {
		t.Fatalf("ListHashRegions: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("initial ListHashRegions = %v, want empty", got)
	}

	if err := s.ReplaceHashRegions([]string{"#eu", "#belgium"}); err != nil {
		t.Fatalf("ReplaceHashRegions: %v", err)
	}
	got, err = s.ListHashRegions()
	if err != nil {
		t.Fatalf("ListHashRegions: %v", err)
	}
	// Alphabetical order per the ORDER BY name in listHashRegions.
	if want := []string{"#belgium", "#eu"}; !stringSlicesEqual(got, want) {
		t.Fatalf("ListHashRegions = %v, want %v", got, want)
	}

	// Full-replace semantics: a second call replaces, doesn't merge.
	if err := s.ReplaceHashRegions([]string{"#usa"}); err != nil {
		t.Fatalf("ReplaceHashRegions (2nd): %v", err)
	}
	got, err = s.ListHashRegions()
	if err != nil {
		t.Fatalf("ListHashRegions: %v", err)
	}
	if want := []string{"#usa"}; !stringSlicesEqual(got, want) {
		t.Fatalf("ListHashRegions after replace = %v, want %v", got, want)
	}

	// Empty slice clears everything.
	if err := s.ReplaceHashRegions(nil); err != nil {
		t.Fatalf("ReplaceHashRegions(nil): %v", err)
	}
	got, err = s.ListHashRegions()
	if err != nil {
		t.Fatalf("ListHashRegions: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("ListHashRegions after clear = %v, want empty", got)
	}
}

func TestRegionsReplaceAndList(t *testing.T) {
	s := openTestStore(t)

	got, err := s.ListRegions()
	if err != nil {
		t.Fatalf("ListRegions: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("initial ListRegions = %v, want empty", got)
	}

	if err := s.ReplaceRegions(map[string]string{"SJC": "San Jose, US", "OAK": "Oakland, US"}); err != nil {
		t.Fatalf("ReplaceRegions: %v", err)
	}
	got, err = s.ListRegions()
	if err != nil {
		t.Fatalf("ListRegions: %v", err)
	}
	want := map[string]string{"SJC": "San Jose, US", "OAK": "Oakland, US"}
	if len(got) != len(want) || got["SJC"] != want["SJC"] || got["OAK"] != want["OAK"] {
		t.Fatalf("ListRegions = %v, want %v", got, want)
	}

	// Full-replace semantics.
	if err := s.ReplaceRegions(map[string]string{"MRY": "Monterey, US"}); err != nil {
		t.Fatalf("ReplaceRegions (2nd): %v", err)
	}
	got, err = s.ListRegions()
	if err != nil {
		t.Fatalf("ListRegions: %v", err)
	}
	if len(got) != 1 || got["MRY"] != "Monterey, US" {
		t.Fatalf("ListRegions after replace = %v, want {MRY: Monterey, US}", got)
	}
}

func TestReadOnlyStoreSeesWriterChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "admin.db")

	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { s.Close() })

	if err := s.ReplaceHashRegions([]string{"#eu"}); err != nil {
		t.Fatalf("ReplaceHashRegions: %v", err)
	}

	ro, err := OpenReadOnly(path)
	if err != nil {
		t.Fatalf("OpenReadOnly: %v", err)
	}
	t.Cleanup(func() { ro.Close() })

	got, err := ro.ListHashRegions()
	if err != nil {
		t.Fatalf("ReadOnlyStore.ListHashRegions: %v", err)
	}
	if want := []string{"#eu"}; !stringSlicesEqual(got, want) {
		t.Fatalf("ReadOnlyStore.ListHashRegions = %v, want %v", got, want)
	}

	// Writer-side changes must be visible to the reader without reopening
	// the connection — this is exactly what cmd/ingestor's 15s reload
	// ticker depends on.
	if err := s.ReplaceHashRegions([]string{"#eu", "#belgium"}); err != nil {
		t.Fatalf("ReplaceHashRegions (2nd): %v", err)
	}
	got, err = ro.ListHashRegions()
	if err != nil {
		t.Fatalf("ReadOnlyStore.ListHashRegions (2nd): %v", err)
	}
	if want := []string{"#belgium", "#eu"}; !stringSlicesEqual(got, want) {
		t.Fatalf("ReadOnlyStore.ListHashRegions after writer change = %v, want %v", got, want)
	}
}

func TestOpenReadOnlyMissingFile(t *testing.T) {
	dir := t.TempDir()
	if _, err := OpenReadOnly(filepath.Join(dir, "does-not-exist.db")); err == nil {
		t.Fatal("OpenReadOnly on a nonexistent file: want error, got nil")
	}
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
