package main

import (
	"encoding/json"
	"net/http"
	"os"
	"sync"
	"time"
)

// staticTraceEvent records one completed request handled by the static SPA
// handler. It is enabled only by the local diagnostic flag and deliberately
// excludes request headers and query values so test evidence cannot record
// credentials or other request data.
type staticTraceEvent struct {
	StartedAt     time.Time `json:"startedAt"`
	FinishedAt    time.Time `json:"finishedAt"`
	ElapsedMicros int64     `json:"elapsedMicros"`
	Method        string    `json:"method"`
	Path          string    `json:"path"`
	Status        int       `json:"status"`
	Bytes         int64     `json:"bytes"`
}

type staticTraceResponseWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
}

func (w *staticTraceResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *staticTraceResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += int64(n)
	return n, err
}

func staticTraceHandler(tracePath string, next http.Handler) (http.Handler, func(), error) {
	file, err := os.OpenFile(tracePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, err
	}
	encoder := json.NewEncoder(file)
	var writeMu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now().UTC()
		traceWriter := &staticTraceResponseWriter{ResponseWriter: w}
		next.ServeHTTP(traceWriter, r)
		finishedAt := time.Now().UTC()
		status := traceWriter.status
		if status == 0 {
			status = http.StatusOK
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = encoder.Encode(staticTraceEvent{
			StartedAt:     startedAt,
			FinishedAt:    finishedAt,
			ElapsedMicros: finishedAt.Sub(startedAt).Microseconds(),
			Method:        r.Method,
			Path:          r.URL.Path,
			Status:        status,
			Bytes:         traceWriter.bytes,
		})
	}), func() { _ = file.Close() }, nil
}
