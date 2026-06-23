// Package mcp serves the blog over the Model Context Protocol at /mcp. It runs
// in-process: tool calls are dispatched to the existing REST handlers with the
// caller's identity injected, so MCP behaves exactly like the REST API (same
// validation, mappers, and business rules) with no second process, no network
// hop, and no API key for data access.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"

	"point-api/internal/api"

	"github.com/labstack/echo/v4"
)

// handlers bundles the REST handlers the MCP tools dispatch to.
type handlers struct {
	post     *api.PostHandler
	tag      *api.TagHandler
	media    *api.MediaHandler
	theme    *api.ThemeHandler
	settings *api.SettingsHandler
	system   *api.SystemHandler
}

// invoker dispatches a single tool call to a REST handler. One is built per MCP
// request (see Register) so it carries that request's context and principal.
type invoker struct {
	ctx        context.Context
	principal  interface{} // models.GetAPIKeyByHashRow or models.GetSessionByTokenRow
	e          *echo.Echo
	h          handlers
	uploadRoot string // sandbox for point_upload_media; empty disables path uploads
}

// call runs handler h with a synthetic echo.Context carrying the invoker's
// context, principal, path params and optional JSON body, returning the response
// body or an error built from the handler's status.
func (in *invoker) call(h echo.HandlerFunc, method, target string, body []byte, params map[string]string) (json.RawMessage, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr).WithContext(in.ctx)
	if body != nil {
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	}
	return in.serve(h, req, params)
}

func (in *invoker) serve(h echo.HandlerFunc, req *http.Request, params map[string]string) (json.RawMessage, error) {
	rec := httptest.NewRecorder()
	c := in.e.NewContext(req, rec)
	if len(params) > 0 {
		names := make([]string, 0, len(params))
		vals := make([]string, 0, len(params))
		for k, v := range params {
			names = append(names, k)
			vals = append(vals, v)
		}
		c.SetParamNames(names...)
		c.SetParamValues(vals...)
	}
	if in.principal != nil {
		c.Set("user", in.principal)
	}
	if err := h(c); err != nil {
		if he, ok := err.(*echo.HTTPError); ok {
			return nil, fmt.Errorf("point API error %d: %v", he.Code, he.Message)
		}
		return nil, err
	}
	data, _ := io.ReadAll(rec.Result().Body)
	if rec.Code >= 400 {
		return nil, fmt.Errorf("point API error %d: %s", rec.Code, detail(data))
	}
	return data, nil
}

// detail pulls a human-readable message from a handler error body.
func detail(data []byte) string {
	var m map[string]any
	if json.Unmarshal(data, &m) == nil {
		for _, k := range []string{"detail", "message", "error"} {
			if v, ok := m[k]; ok {
				return fmt.Sprint(v)
			}
		}
	}
	return strings.TrimSpace(string(data))
}

// uploadFile reads a sandboxed local file and posts it to the media handler as a
// multipart upload.
func (in *invoker) uploadFile(filePath string) (json.RawMessage, error) {
	resolved, err := in.resolveUploadPath(filePath)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(resolved)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", filepath.Base(resolved))
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, f); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}

	req := httptest.NewRequest(http.MethodPost, "/api/media/upload", &buf).WithContext(in.ctx)
	req.Header.Set(echo.HeaderContentType, w.FormDataContentType())
	return in.serve(in.h.media.UploadFile, req, nil)
}

// resolveUploadPath confirms filePath resolves to a real file inside uploadRoot
// (symlinks resolved on both sides so a link cannot escape the sandbox). It
// fails closed when no root is configured — the server runs on the blog host, so
// an unrestricted path would be an arbitrary file-read primitive.
func (in *invoker) resolveUploadPath(filePath string) (string, error) {
	if in.uploadRoot == "" {
		return "", fmt.Errorf("server-side file upload is disabled (set PHOTO_LIBRARY_PATH to an allowed upload directory)")
	}
	root, err := filepath.EvalSymlinks(in.uploadRoot)
	if err != nil {
		return "", fmt.Errorf("upload directory is unavailable")
	}
	resolved, err := filepath.EvalSymlinks(filePath)
	if err != nil {
		return "", fmt.Errorf("file not found")
	}
	rel, err := filepath.Rel(root, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path is outside the allowed upload directory")
	}
	return resolved, nil
}
