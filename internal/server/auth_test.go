package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

const testAuthToken = "test-token-abc123"

func TestAuth_DisabledByDefault(t *testing.T) {
	s := newTestState(t)
	handler := NewHandler(s) // no SetAuth → auth disabled

	req := httptest.NewRequest("GET", "/_/api/groups", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("auth-disabled request: got %d, want 200", rec.Code)
	}
}

func TestAuth_RequiresTokenOnAPI(t *testing.T) {
	s := newTestState(t)
	s.SetAuth(testAuthToken, nil)
	handler := NewHandler(s)

	t.Run("no credential is rejected", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", rec.Code)
		}
	})

	t.Run("wrong token is rejected", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		req.Header.Set(authHeaderName, "wrong")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("got %d, want 401", rec.Code)
		}
	})

	t.Run("correct header token is accepted", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		req.Header.Set(authHeaderName, testAuthToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d, want 200", rec.Code)
		}
	})

	t.Run("correct cookie is accepted", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		req.AddCookie(&http.Cookie{Name: authCookieName, Value: testAuthToken}) //nolint:gosec // G124: client-side request cookie in a test; security attributes are irrelevant.
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d, want 200", rec.Code)
		}
	})
}

func TestAuth_IssuesCookieOnSPA(t *testing.T) {
	s := newTestState(t)
	s.SetAuth(testAuthToken, nil)
	handler := NewHandler(s)

	// The SPA / static routes must not require a token (bootstrap) and must set
	// the auth cookie so the browser carries it on same-origin API calls.
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	var cookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == authCookieName {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatal("SPA response did not set the auth cookie")
	}
	if cookie.Value != testAuthToken {
		t.Fatalf("cookie value = %q, want %q", cookie.Value, testAuthToken)
	}
	if cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("cookie SameSite = %v, want Strict", cookie.SameSite)
	}
	if !cookie.HttpOnly {
		t.Fatal("cookie should be HttpOnly")
	}
	if !cookie.Secure {
		t.Fatal("cookie should set Secure")
	}
}

func TestAuth_HostAllowlist(t *testing.T) {
	s := newTestState(t)
	s.SetAuth(testAuthToken, []string{"localhost:6275"})
	handler := NewHandler(s)

	t.Run("disallowed host is rejected (DNS-rebinding defense)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		req.Host = "evil.example"
		req.Header.Set(authHeaderName, testAuthToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("got %d, want 403", rec.Code)
		}
	})

	t.Run("allowed host with token is accepted", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/_/api/groups", nil)
		req.Host = "localhost:6275"
		req.Header.Set(authHeaderName, testAuthToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("got %d, want 200", rec.Code)
		}
	})
}
