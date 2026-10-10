package main

import "testing"

func TestHTTPListenAddress(t *testing.T) {
	tests := []struct {
		name string
		host string
		port int
		want string
	}{
		{name: "all interfaces", host: "", port: 8080, want: ":8080"},
		{name: "IPv4 loopback", host: "127.0.0.1", port: 13581, want: "127.0.0.1:13581"},
		{name: "IPv6 loopback", host: "::1", port: 13581, want: "[::1]:13581"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := httpListenAddress(tt.host, tt.port); got != tt.want {
				t.Fatalf("httpListenAddress(%q, %d) = %q, want %q", tt.host, tt.port, got, tt.want)
			}
		})
	}
}
