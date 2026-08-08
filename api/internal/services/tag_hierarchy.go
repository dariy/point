package services

// Writes to the tag hierarchy: adding and replacing parent/child edges, and
// reordering or moving a tag within a sibling group. Split out of
// tag_service.go because the write path has a different shape from the read
// path — it goes to the repository rather than the graph, guards every new
// edge with detectCycle, and has to invalidate the cache on the way out.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
)

// AddTagRelationship adds a parent-child relationship between two tags with cycle detection.
func (s *TagService) AddTagRelationship(ctx context.Context, parentID, childID int64) error {
	// Check for cycles: if parentID is already a descendant of childID, adding parentID -> childID creates a cycle.
	path, err := s.detectCycle(ctx, childID, parentID)
	if err != nil {
		return err
	}
	if path != nil {
		return wrapKind(ErrConflict, fmt.Errorf("Cycle detected: %s", strings.Join(path, " -> "))) //nolint:staticcheck // ST1005: user-facing message, wording preserved from before the taxonomy
	}

	if err := s.repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{
		ParentID: parentID,
		ChildID:  childID,
	}); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

func (s *TagService) detectCycle(ctx context.Context, startID, targetID int64) ([]string, error) {
	type node struct {
		id   int64
		path []string
	}

	startTag, err := s.repo.GetTag(ctx, startID)
	if err != nil {
		return nil, err
	}

	queue := []node{{id: startID, path: []string{startTag.Slug}}}
	visited := map[int64]bool{startID: true}

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		if curr.id == targetID {
			targetTag, _ := s.repo.GetTag(ctx, targetID)
			fullPath := append([]string{targetTag.Slug}, curr.path...)
			return fullPath, nil
		}

		children, err := s.repo.GetTagChildren(ctx, curr.id)
		if err != nil {
			return nil, err
		}

		for _, child := range children {
			if !visited[child.ID] {
				visited[child.ID] = true
				newPath := append([]string{}, curr.path...)
				newPath = append(newPath, child.Slug)
				queue = append(queue, node{id: child.ID, path: newPath})
			}
		}
	}

	return nil, nil
}

// SetTagParents replaces all parent relationships for a tag.
func (s *TagService) SetTagParents(ctx context.Context, tagID int64, parentIDs []int64) error {
	if err := s.repo.ClearTagParents(ctx, tagID); err != nil {
		return err
	}
	for _, parentID := range parentIDs {
		if err := s.AddTagRelationship(ctx, parentID, tagID); err != nil {
			return err
		}
	}

	return nil
}

// SetTagChildren replaces all child relationships for a tag.
func (s *TagService) SetTagChildren(ctx context.Context, tagID int64, childIDs []int64) error {
	if err := s.repo.ClearTagChildren(ctx, tagID); err != nil {
		return err
	}
	for _, childID := range childIDs {
		if err := s.AddTagRelationship(ctx, tagID, childID); err != nil {
			return err
		}
	}
	return nil
}

// GetAllTagRelationships returns all parent-child tag pairs.
func (s *TagService) GetAllTagRelationships(ctx context.Context) ([]repository.TagRelationship, error) {
	return s.repo.GetAllTagRelationships(ctx)
}

// ReorderTagParams describes a drag-and-drop reorder request.
type ReorderTagParams struct {
	ID       int64
	TargetID *int64 // nil = move to end
	Position string // "before" or "after"
	ParentID *int64 // nil = root level
}

// ReorderTag reorders a tag within its sibling group by updating sort_order values.
func (s *TagService) ReorderTag(ctx context.Context, p ReorderTagParams) error {
	if p.Position != "before" && p.Position != "after" {
		return wrapKind(ErrInvalidInput, errors.New("position must be 'before' or 'after'"))
	}

	dragged, err := s.repo.GetTag(ctx, p.ID)
	if err != nil {
		return wrapKind(ErrNotFound, fmt.Errorf("tag %d not found", p.ID))
	}

	var siblings []models.Tag
	if p.ParentID != nil {
		siblings, err = s.repo.GetChildrenOfTag(ctx, *p.ParentID)
	} else {
		siblings, err = s.repo.GetRootTags(ctx)
	}
	if err != nil {
		return err
	}

	// Find and remove the dragged tag from siblings (may not be present on cross-hierarchy move).
	draggedIdx := -1
	for i, t := range siblings {
		if t.ID == p.ID {
			draggedIdx = i
			break
		}
	}
	if draggedIdx != -1 {
		siblings = append(siblings[:draggedIdx], siblings[draggedIdx+1:]...)
	} else {
		// Cross-hierarchy move: reparent the dragged tag to the target parent.
		var newParents []int64
		if p.ParentID != nil {
			newParents = []int64{*p.ParentID}
		}
		if err := s.SetTagParents(ctx, p.ID, newParents); err != nil {
			return fmt.Errorf("reparent tag %q: %w", dragged.Slug, err)
		}
	}

	// Find insert position relative to target.
	insertAt := len(siblings)
	if p.TargetID != nil {
		for i, t := range siblings {
			if t.ID == *p.TargetID {
				if p.Position == "before" {
					insertAt = i
				} else {
					insertAt = i + 1
				}
				break
			}
		}
	}

	// Insert dragged at the new position.
	siblings = append(siblings, models.Tag{})
	copy(siblings[insertAt+1:], siblings[insertAt:])
	siblings[insertAt] = dragged

	// Assign sort_orders 10, 20, 30, ...
	for i, t := range siblings {
		if err := s.repo.UpdateTagSortOrder(ctx, t.ID, int32((i+1)*10)); err != nil {
			return err
		}
	}
	s.Invalidate()
	return nil
}

// MoveTagParams describes a move request within a specific parent's sibling group.
type MoveTagParams struct {
	ID       int64
	ParentID int64
	AfterID  *int64 // nil = move to front
}

// MoveTag repositions a tag within its sibling group under a specific parent.
// Only the sort_order values for edges under ParentID are renumbered; other
// parents are untouched.
func (s *TagService) MoveTag(ctx context.Context, p MoveTagParams) error {
	g, err := s.getGraph(ctx)
	if err != nil {
		return err
	}

	// Verify tag exists.
	if _, ok := g.ByID[p.ID]; !ok {
		return ErrTagNotFound
	}

	// Verify tag is a child of the given parent.
	isChild := false
	for _, childID := range g.Children[p.ParentID] {
		if childID == p.ID {
			isChild = true
			break
		}
	}
	if !isChild {
		return ErrTagNotAChild
	}

	// Get all siblings under this parent ordered by sort_order (from DB, authoritative).
	siblings, err := s.repo.GetChildrenOfTag(ctx, p.ParentID)
	if err != nil {
		return err
	}

	// Remove the moving tag from the sibling list.
	filtered := siblings[:0]
	for _, t := range siblings {
		if t.ID != p.ID {
			filtered = append(filtered, t)
		}
	}

	// Find insert position.
	insertAt := len(filtered)
	if p.AfterID == nil {
		insertAt = 0
	} else {
		for i, t := range filtered {
			if t.ID == *p.AfterID {
				insertAt = i + 1
				break
			}
		}
	}

	// Insert the moving tag at the new position.
	result := make([]models.Tag, 0, len(siblings))
	result = append(result, filtered[:insertAt]...)
	result = append(result, g.ByID[p.ID])
	result = append(result, filtered[insertAt:]...)

	// Renumber with per-edge sort_order = 10, 20, 30, ...
	for i, t := range result {
		if err := s.repo.UpdateEdgeSortOrder(ctx, p.ParentID, t.ID, int32((i+1)*10)); err != nil {
			return err
		}
	}

	s.Invalidate()
	return nil
}
