package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

func TestParseCoordsFromURL(t *testing.T) {
	tests := []struct {
		name    string
		url     string
		wantLat float64
		wantLng float64
		wantOk  bool
	}{
		{
			name:    "google maps @lat,lng path",
			url:     "https://maps.google.com/maps/@48.8566,2.3522,15z",
			wantLat: 48.8566, wantLng: 2.3522, wantOk: true,
		},
		{
			name:    "ll= query param",
			url:     "https://maps.google.com/?ll=51.5074,-0.1278",
			wantLat: 51.5074, wantLng: -0.1278, wantOk: true,
		},
		{
			name:    "q= query param with raw coords",
			url:     "https://maps.google.com/?q=40.7128,-74.0060",
			wantLat: 40.7128, wantLng: -74.0060, wantOk: true,
		},
		{
			name:    "sll= query param",
			url:     "https://maps.apple.com/?sll=35.6762,139.6503",
			wantLat: 35.6762, wantLng: 139.6503, wantOk: true,
		},
		{
			name:   "no coords in url",
			url:    "https://example.com/page",
			wantOk: false,
		},
		{
			name:   "empty string",
			url:    "",
			wantOk: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lat, lng, ok := parseCoordsFromURL(tt.url)
			if ok != tt.wantOk {
				t.Errorf("ok=%v, want %v", ok, tt.wantOk)
			}
			if ok && (lat != tt.wantLat || lng != tt.wantLng) {
				t.Errorf("got (%v,%v), want (%v,%v)", lat, lng, tt.wantLat, tt.wantLng)
			}
		})
	}
}

func TestParseCoordsFromDegreeString(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantLat float64
		wantLng float64
		wantOk  bool
	}{
		{
			name:    "N/E",
			input:   "48.8566° N, 2.3522° E",
			wantLat: 48.8566, wantLng: 2.3522, wantOk: true,
		},
		{
			name:    "S/W negates both",
			input:   "33.8688° S, 151.2093° W",
			wantLat: -33.8688, wantLng: -151.2093, wantOk: true,
		},
		{
			name:    "no degree symbol",
			input:   "45.50777 N, 73.55446 W",
			wantLat: 45.50777, wantLng: -73.55446, wantOk: true,
		},
		{
			name:   "invalid string",
			input:  "not coordinates",
			wantOk: false,
		},
		{
			name:   "empty",
			input:  "",
			wantOk: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lat, lng, ok := parseCoordsFromDegreeString(tt.input)
			if ok != tt.wantOk {
				t.Errorf("ok=%v, want %v", ok, tt.wantOk)
			}
			if ok && (lat != tt.wantLat || lng != tt.wantLng) {
				t.Errorf("got (%v,%v), want (%v,%v)", lat, lng, tt.wantLat, tt.wantLng)
			}
		})
	}
}

func TestParseMapsCoords_Handler(t *testing.T) {
	e := echo.New()

	// Missing q param
	req := httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := ParseMapsCoords(c)
	if err == nil {
		t.Error("expected error for missing q param")
	}

	// Degree string input
	req = httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=48.8566+N%2C+2.3522+E", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := ParseMapsCoords(c); err != nil {
		t.Errorf("ParseMapsCoords with degree string failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid text input
	req = httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=not+a+coordinate", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	err = ParseMapsCoords(c)
	if err == nil {
		t.Error("expected error for unrecognised input")
	}

	// URL with disallowed host
	req = httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=https://evil.com/maps", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	err = ParseMapsCoords(c)
	if err == nil {
		t.Error("expected error for disallowed host")
	}

	// Valid Google Maps URL with coords
	req = httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=https://maps.google.com/maps/@48.8566,2.3522,15z", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := ParseMapsCoords(c); err != nil {
		t.Errorf("ParseMapsCoords with google maps URL failed: %v", err)
	}

	// Apple Maps page URL (fetches body) — mock with httptest server
	pageServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"lat":45.5077734,"lng":-73.5544607}`))
	}))
	defer pageServer.Close()
	// parseCoordsFromPageBody is called internally; we test it via a direct call
	lat, lng, ok := parseCoordsFromPageBody(pageServer.URL)
	if !ok {
		t.Error("parseCoordsFromPageBody: expected ok=true with mock server")
	}
	if lat != 45.5077734 || lng != -73.5544607 {
		t.Errorf("parseCoordsFromPageBody: got (%v,%v), want (45.5077734,-73.5544607)", lat, lng)
	}
}
