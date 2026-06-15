//go:build integration

package services

import (
	"context"
	"testing"
)

func TestTagService_MoveTagScoping(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewTagService(repo)
	ctx := context.Background()

	// 1. Setup: parents X and Y
	parentX, _ := svc.CreateTag(ctx, CreateTagParams{Name: "X"})
	parentY, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Y"})

	// tag T child of BOTH
	tagT, _ := svc.CreateTag(ctx, CreateTagParams{Name: "T"})
	_ = svc.SetTagParents(ctx, tagT.ID, []int64{parentX.ID, parentY.ID})

	// siblings X1,X2 under X
	tagX1, _ := svc.CreateTag(ctx, CreateTagParams{Name: "X1"})
	tagX2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "X2"})
	_ = svc.SetTagParents(ctx, tagX1.ID, []int64{parentX.ID})
	_ = svc.SetTagParents(ctx, tagX2.ID, []int64{parentX.ID})

	// siblings Y1,Y2 under Y
	tagY1, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Y1"})
	tagY2, _ := svc.CreateTag(ctx, CreateTagParams{Name: "Y2"})
	_ = svc.SetTagParents(ctx, tagY1.ID, []int64{parentY.ID})
	_ = svc.SetTagParents(ctx, tagY2.ID, []int64{parentY.ID})

	// Ensure known sort_order for Y group
	// T is already a child of Y from SetTagParents above.
	// Let's Authoritatively set sort orders to be sure.
	_ = repo.UpdateEdgeSortOrder(ctx, parentY.ID, tagY1.ID, 100)
	_ = repo.UpdateEdgeSortOrder(ctx, parentY.ID, tagY2.ID, 200)
	_ = repo.UpdateEdgeSortOrder(ctx, parentY.ID, tagT.ID, 300)

	// Authoritatively set sort orders for X group
	_ = repo.UpdateEdgeSortOrder(ctx, parentX.ID, tagX1.ID, 10)
	_ = repo.UpdateEdgeSortOrder(ctx, parentX.ID, tagX2.ID, 20)
	_ = repo.UpdateEdgeSortOrder(ctx, parentX.ID, tagT.ID, 30)

	// 2. Call MoveTag(T, parent_id=X, after_id=X2)
	err := svc.MoveTag(ctx, MoveTagParams{
		ID:       tagT.ID,
		ParentID: parentX.ID,
		AfterID:  &tagX2.ID,
	})
	if err != nil {
		t.Fatalf("MoveTag failed: %v", err)
	}

	// (a) order under X should be X1,X2,T (10, 20, 30 usually from renumbering)
	childrenX, _ := repo.GetChildrenOfTag(ctx, parentX.ID)
	if len(childrenX) != 3 {
		t.Errorf("expected 3 children under X, got %d", len(childrenX))
	} else {
		if childrenX[0].ID != tagX1.ID || childrenX[1].ID != tagX2.ID || childrenX[2].ID != tagT.ID {
			t.Errorf("unexpected order under X: %v, %v, %v", childrenX[0].Name, childrenX[1].Name, childrenX[2].Name)
		}
	}

	// (b) the edge (Y,T) still exists with its original sort_order
	// And Y1,Y2 sort_order values are unchanged.
	// NOTE: GetChildrenOfTag returns tags, but I need sort_order.
	// I'll check raw DB for edges.
	type edge struct {
		pid, cid int64
		so       int32
	}
	var edgesY []edge
	rows, _ := repo.DB().Query(`SELECT parent_id, child_id, sort_order FROM tag_relationships WHERE parent_id = ? ORDER BY sort_order`, parentY.ID)
	for rows.Next() {
		var e edge
		_ = rows.Scan(&e.pid, &e.cid, &e.so)
		edgesY = append(edgesY, e)
	}
	_ = rows.Close()

	if len(edgesY) != 3 {
		t.Errorf("expected 3 edges under Y, got %d", len(edgesY))
	} else {
		// Y1: 100, Y2: 200, T: 300
		if edgesY[0].cid != tagY1.ID || edgesY[0].so != 100 {
			t.Errorf("Y1 edge changed: %v", edgesY[0])
		}
		if edgesY[1].cid != tagY2.ID || edgesY[1].so != 200 {
			t.Errorf("Y2 edge changed: %v", edgesY[1])
		}
		if edgesY[2].cid != tagT.ID || edgesY[2].so != 300 {
			t.Errorf("T edge under Y changed: %v", edgesY[2])
		}
	}

	// (c) MoveTag with after_id=null places T first under X
	err = svc.MoveTag(ctx, MoveTagParams{
		ID:       tagT.ID,
		ParentID: parentX.ID,
		AfterID:  nil,
	})
	if err != nil {
		t.Fatalf("MoveTag (first) failed: %v", err)
	}
	childrenX, _ = repo.GetChildrenOfTag(ctx, parentX.ID)
	if len(childrenX) != 3 {
		t.Errorf("expected 3 children under X, got %d", len(childrenX))
	} else if childrenX[0].ID != tagT.ID {
		t.Errorf("expected T first under X, got %s", childrenX[0].Name)
	}
}
