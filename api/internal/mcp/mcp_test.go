package mcp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestRegisterTools verifies the full tool set registers with the expected names.
// Registration only captures the invoker in closures (no handler calls), so a
// zero invoker is sufficient here.
func TestRegisterTools(t *testing.T) {
	srv := sdk.NewServer(&sdk.Implementation{Name: "point-mcp", Version: "test"}, nil)
	inv := &invoker{}
	registerTools(srv, inv)
	registerResources(srv, inv)
	registerPrompts(srv)

	clientT, serverT := sdk.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := srv.Connect(ctx, serverT, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer cs.Close()

	res, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	if len(res.Tools) != 28 {
		t.Errorf("expected 28 tools, got %d", len(res.Tools))
	}
	for _, tool := range res.Tools {
		if !strings.HasPrefix(tool.Name, "point_") {
			t.Errorf("tool %q missing point_ prefix", tool.Name)
		}
	}
}

func TestResolveUploadPath(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "photo.jpg")
	if err := os.WriteFile(inside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := (&invoker{uploadRoot: ""}).resolveUploadPath(inside); err == nil {
		t.Error("expected error when uploadRoot is empty")
	}
	if _, err := (&invoker{uploadRoot: root}).resolveUploadPath(inside); err != nil {
		t.Errorf("expected file inside root to be allowed: %v", err)
	}
	if _, err := (&invoker{uploadRoot: root}).resolveUploadPath(outside); err == nil {
		t.Error("expected error for path outside root")
	}

	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err == nil {
		if _, err := (&invoker{uploadRoot: root}).resolveUploadPath(link); err == nil {
			t.Error("expected error for symlink escaping root")
		}
	}
}
