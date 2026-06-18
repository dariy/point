package services

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
)

type mockRepository struct {
	// Querier methods
	MockAddPostViewCount          func(ctx context.Context, arg models.AddPostViewCountParams) error
	MockAddTagRelationship        func(ctx context.Context, arg models.AddTagRelationshipParams) error
	MockAddTagToPost              func(ctx context.Context, arg models.AddTagToPostParams) error
	MockBulkPublishScheduledPosts func(ctx context.Context) ([]models.Post, error)
	MockClearPostTags             func(ctx context.Context, postID int64) error
	MockClearTagRelationships     func(ctx context.Context, arg models.ClearTagRelationshipsParams) error
	MockCountMedia                func(ctx context.Context, arg models.CountMediaParams) (int64, error)
	MockCountPosts                func(ctx context.Context, arg models.CountPostsParams) (int64, error)
	MockCountPostsByTag           func(ctx context.Context, arg models.CountPostsByTagParams) (int64, error)
	MockCountTrashedPosts         func(ctx context.Context) (int64, error)
	MockCreateAPIKey              func(ctx context.Context, arg models.CreateAPIKeyParams) (models.ApiKey, error)
	MockCreateMedia               func(ctx context.Context, arg models.CreateMediaParams) (models.Medium, error)
	MockCreatePost                func(ctx context.Context, arg models.CreatePostParams) (models.Post, error)
	MockCreateSession             func(ctx context.Context, arg models.CreateSessionParams) (models.Session, error)
	MockCreateTag                 func(ctx context.Context, arg models.CreateTagParams) (models.Tag, error)
	MockCreateUser                func(ctx context.Context, arg models.CreateUserParams) (models.User, error)
	MockDeleteAPIKey              func(ctx context.Context, arg models.DeleteAPIKeyParams) error
	MockDeleteExpiredSessions     func(ctx context.Context) error
	MockDeleteMedia               func(ctx context.Context, id int64) error
	MockDeletePost                func(ctx context.Context, arg models.DeletePostParams) error
	MockDeletePostTagsByTag       func(ctx context.Context, tagID int64) error
	MockDeleteSession             func(ctx context.Context, arg models.DeleteSessionParams) error
	MockDeleteSetting             func(ctx context.Context, key string) error
	MockDeleteTag                 func(ctx context.Context, id int64) error
	MockDeleteUserSessions        func(ctx context.Context, arg models.DeleteUserSessionsParams) error
	MockGetAPIKeyByHash           func(ctx context.Context, keyHash string) (models.GetAPIKeyByHashRow, error)
	MockGetFirstUser              func(ctx context.Context) (models.User, error)
	MockGetMedia                  func(ctx context.Context, id int64) (models.Medium, error)
	MockGetMediaByChecksum        func(ctx context.Context, checksum string) (models.Medium, error)
	MockGetMediaByPostID          func(ctx context.Context, postID sql.NullInt64) ([]models.Medium, error)
	MockGetPost                   func(ctx context.Context, id int64) (models.Post, error)
	MockGetPostAnalytics          func(ctx context.Context) (models.GetPostAnalyticsRow, error)
	MockGetPostBySlug             func(ctx context.Context, slug string) (models.Post, error)
	MockGetPostsByTag             func(ctx context.Context, arg models.GetPostsByTagParams) ([]models.Post, error)
	MockGetSecret                 func(ctx context.Context, key string) (models.BlogSecret, error)
	MockGetSessionByToken         func(ctx context.Context, token string) (models.GetSessionByTokenRow, error)
	MockGetSetting                func(ctx context.Context, key string) (models.BlogSetting, error)
	MockGetStorageUsage           func(ctx context.Context) (sql.NullFloat64, error)
	MockGetTag                    func(ctx context.Context, id int64) (models.Tag, error)
	MockGetTagBySlug              func(ctx context.Context, slug string) (models.Tag, error)
	MockGetTagChildren            func(ctx context.Context, parentID int64) ([]models.Tag, error)
	MockGetTagParents             func(ctx context.Context, childID int64) ([]models.Tag, error)
	MockGetTagsForPost            func(ctx context.Context, postID int64) ([]models.Tag, error)
	MockGetUser                   func(ctx context.Context, id int64) (models.User, error)
	MockGetUserByEmail            func(ctx context.Context, email string) (models.User, error)
	MockGetUserByUsername         func(ctx context.Context, username string) (models.User, error)
	MockGetUserSessions           func(ctx context.Context, userID int64) ([]models.Session, error)
	MockIncrementPostViewCount    func(ctx context.Context, id int64) error
	MockListAPIKeysByUser         func(ctx context.Context, userID int64) ([]models.ApiKey, error)
	MockListMedia                 func(ctx context.Context, arg models.ListMediaParams) ([]models.Medium, error)
	MockListPosts                 func(ctx context.Context, arg models.ListPostsParams) ([]models.Post, error)
	MockListPostsByViews          func(ctx context.Context, arg models.ListPostsByViewsParams) ([]models.Post, error)
	MockListSettings              func(ctx context.Context) ([]models.BlogSetting, error)
	MockListTags                  func(ctx context.Context, includeEmptyFilter interface{}) ([]models.Tag, error)
	MockListTrashedPosts          func(ctx context.Context, arg models.ListTrashedPostsParams) ([]models.Post, error)
	MockMergePostTags         func(ctx context.Context, arg models.MergePostTagsParams) error
	MockMergeTagChildren      func(ctx context.Context, arg models.MergeTagChildrenParams) error
	MockMergeTagParents       func(ctx context.Context, arg models.MergeTagParentsParams) error
	MockMergeTags             func(ctx context.Context, winnerID, loserID int64) error
	MockPublishPost           func(ctx context.Context, id int64) (models.Post, error)
	MockRemoveTagFromPost         func(ctx context.Context, arg models.RemoveTagFromPostParams) error
	MockRemoveTagRelationship     func(ctx context.Context, arg models.RemoveTagRelationshipParams) error
	MockRestorePost               func(ctx context.Context, arg models.RestorePostParams) error
	MockRevokeAPIKey              func(ctx context.Context, arg models.RevokeAPIKeyParams) error
	MockSetPostPreviewToken       func(ctx context.Context, arg models.SetPostPreviewTokenParams) error
	MockSoftDeletePost            func(ctx context.Context, arg models.SoftDeletePostParams) error
	MockTouchAPIKeyLastUsed       func(ctx context.Context, id int64) error
	MockUpdateAllTagPostCounts    func(ctx context.Context) error
	MockUpdateMedia               func(ctx context.Context, arg models.UpdateMediaParams) (models.Medium, error)
	MockUpdateMediaFilename       func(ctx context.Context, arg models.UpdateMediaFilenameParams) (models.Medium, error)
	MockUpdateMediaMetadata       func(ctx context.Context, arg models.UpdateMediaMetadataParams) (models.Medium, error)
	MockUpdatePost                func(ctx context.Context, arg models.UpdatePostParams) (models.Post, error)
	MockUpdateSessionActivity     func(ctx context.Context, id int64) error
	MockUpdateSetting             func(ctx context.Context, arg models.UpdateSettingParams) (models.BlogSetting, error)
	MockUpdateTag                 func(ctx context.Context, arg models.UpdateTagParams) (models.Tag, error)
	MockUpdateTagPostCount        func(ctx context.Context, id int64) error
	MockUpdateUserLogin           func(ctx context.Context, id int64) error
	MockUpdateUserPassword        func(ctx context.Context, arg models.UpdateUserPasswordParams) error
	MockUpsertSecret              func(ctx context.Context, arg models.UpsertSecretParams) error
	MockUpdatePostInstagramStatus func(ctx context.Context, arg models.UpdatePostInstagramStatusParams) error
	MockWithdrawPost              func(ctx context.Context, id int64) (models.Post, error)
	// Repository methods
	MockClose                               func() error
	MockDB                                  func() *sql.DB
	MockDeleteSecret                        func(ctx context.Context, key string) error
	MockCreateWebAuthnCredential            func(ctx context.Context, userID int64, credID, pubKey, aaguid []byte, signCount uint32, backupEligible, backupState bool) (*repository.WebAuthnCredential, error)
	MockGetWebAuthnCredentialsByUserID      func(ctx context.Context, userID int64) ([]repository.WebAuthnCredential, error)
	MockGetWebAuthnCredentialByCredentialID func(ctx context.Context, credID []byte) (*repository.WebAuthnCredential, error)
	MockDeleteWebAuthnCredentialByUserID    func(ctx context.Context, userID int64) error
	MockUpdateWebAuthnCredential            func(ctx context.Context, credID []byte, signCount uint32, backupState bool) error
	MockGetPublishedPostsForFeed         func(ctx context.Context, limit int) ([]models.Post, error)
	MockGetPublishedPostsForSitemap      func(ctx context.Context) ([]struct {
		Slug      string
		UpdatedAt time.Time
	}, error)
	MockGetPublicTagsForSitemap func(ctx context.Context) ([]struct {
		ID   int64
		Slug string
	}, error)
	MockUpsertTagLocation          func(ctx context.Context, tagID int64, lat, lon float64) error
	MockGetTagLocationsByTagIDs         func(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error)
	MockDeleteTagLocation               func(ctx context.Context, tagID int64) error
	MockListOrphanedMedia               func(ctx context.Context, limit, offset int64) ([]models.Medium, error)
	MockCountOrphanedMedia              func(ctx context.Context) (int64, error)
	MockGetMediaByIDs                   func(ctx context.Context, ids []int64) ([]models.Medium, error)
	MockDeleteMediaByIDs                func(ctx context.Context, ids []int64) error
	MockListOrphanedMediaByPage         func(ctx context.Context, limit, offset int64) ([]models.Medium, int64, error)
	MockListMediaFolders                func(ctx context.Context, fileType string) ([]repository.MediaFolder, error)
	MockListMediaFiltered               func(ctx context.Context, fileType, folder string, limit, offset int64) ([]models.Medium, error)
	MockCountMediaFiltered              func(ctx context.Context, fileType, folder string) (int64, error)
	MockGetMediaByPath                  func(ctx context.Context, originalPath string) (models.Medium, error)
	MockSetMediaPublic                  func(ctx context.Context, mediaID int64, isPublic bool, postID *int64) error
	MockGetAllMediaPaths                func(ctx context.Context) ([]models.Medium, error)
	MockGetMediaByPaths                 func(ctx context.Context, paths []string) ([]models.Medium, error)
	MockGetStorageStats                 func(ctx context.Context) (repository.StorageStats, error)
	MockGetMigrations                   func(ctx context.Context) ([]repository.MigrationRecord, error)
	MockApplyMigration                  func(ctx context.Context, name, sql string) error
	MockMigrateFlagsToSystemTags        func(ctx context.Context) error
	MockRebuildTagsTableDropBooleans    func(ctx context.Context) error
	MockEnsureSystemTags                func(ctx context.Context) error
	MockMigrateTagFlagsFromSystemTags   func(ctx context.Context) error
	MockListPostsInYearRange            func(ctx context.Context, fromYear, toYear int, arg models.ListPostsParams) ([]models.Post, error)
	MockCountPostsInYearRange           func(ctx context.Context, fromYear, toYear int, arg models.CountPostsParams) (int64, error)
	MockListPostsWithSearch             func(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool, limit, offset int64) ([]models.Post, error)
	MockCountPostsWithSearch            func(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool) (int64, error)
	MockGetPostByPreviewToken           func(ctx context.Context, token string) (models.Post, error)
	MockGetPostNavigation               func(ctx context.Context, postID int64, publicOnly bool) (prev, next *repository.PostNavItem, err error)
	MockReplacePostContentPath          func(ctx context.Context, oldPath, newPath string) (int64, error)
	MockUpdatePostThumbnailPath         func(ctx context.Context, oldPath, newPath string) (int64, error)
	MockListPublishedPostStubs          func(ctx context.Context) ([]repository.PostStub, error)
	MockListPostNodesForGraph           func(ctx context.Context, publishedOnly bool) ([]repository.GraphPostNode, error)
	MockGetPostsByTagIDs                func(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	MockCountPostsByTagIDs              func(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	MockGetPostsByTagIDsInYearRange     func(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error)
	MockCountPostsByTagIDsInYearRange   func(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error)
	MockGetAllPublishedPostContents     func(ctx context.Context) ([]repository.PostContentRow, error)
	MockGetHierarchicalPostCounts       func(ctx context.Context, publishedOnly bool) (map[int64]int64, error)
	MockGetSystemStats                  func(ctx context.Context) (repository.SystemStats, error)
	MockBackupDB                        func(ctx context.Context, destPath string) error
	MockSearchTags                      func(ctx context.Context, query string, limit int) ([]models.Tag, error)
	MockGetTagAncestors                 func(ctx context.Context, tagID int64) ([]models.Tag, error)
	MockGetTagDescendants               func(ctx context.Context, tagID int64) ([]models.Tag, error)
	MockGetCoOccurringTags              func(ctx context.Context, tagID int64, publicOnly bool) ([]models.Tag, error)
	MockGetAllTagRelationships          func(ctx context.Context) ([]repository.TagRelationship, error)
	MockClearTagParents                 func(ctx context.Context, childID int64) error
	MockClearTagChildren                func(ctx context.Context, parentID int64) error
	MockGetTagsWithoutLocation          func(ctx context.Context, tagIDs []int64) ([]models.Tag, error)
	MockFindTagsByNames                 func(ctx context.Context, names []string) ([]models.Tag, error)
	MockGetTagsByPostIDs                func(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error)
	MockGetChildrenOfTag                func(ctx context.Context, parentID int64) ([]models.Tag, error)
	MockGetRootTags                     func(ctx context.Context) ([]models.Tag, error)
	MockUpdateTagSortOrder              func(ctx context.Context, id int64, sortOrder int32) error
	MockListMapTagsForYearRange         func(ctx context.Context, fromYear, toYear int) ([]repository.MapYearRangeTag, error)
	MockListInTimelineDescendants       func(ctx context.Context) ([]repository.InTimelineTag, error)
	MockListInTimelineDescendantsForTag func(ctx context.Context, contextTagSlug string) ([]repository.InTimelineTag, error)
	MockGetLocationTagsCoOccurringWith  func(ctx context.Context, dateTagSlug, contextTagSlug string, limit int) ([]repository.LocationTagCoOccurrence, error)
	MockGetYearTagsByLocationTagIDs     func(ctx context.Context, locTagIDs []int64) (map[int64][]repository.PostTagInfo, error)
	MockGetExistingInstagramIDs         func(ctx context.Context, ids []string) ([]string, error)
	MockSetPostInstagramID              func(ctx context.Context, postID int64, instagramID string) error
}

// Ensure mockRepository implements repository.Repository
var _ repository.Repository = (*mockRepository)(nil)

// Implementation of Querier methods

func (m *mockRepository) AddPostViewCount(ctx context.Context, arg models.AddPostViewCountParams) error {
	if m.MockAddPostViewCount != nil {
		return m.MockAddPostViewCount(ctx, arg)
	}
	return fmt.Errorf("AddPostViewCount not implemented")
}

func (m *mockRepository) AddTagRelationship(ctx context.Context, arg models.AddTagRelationshipParams) error {
	if m.MockAddTagRelationship != nil {
		return m.MockAddTagRelationship(ctx, arg)
	}
	return fmt.Errorf("AddTagRelationship not implemented")
}

func (m *mockRepository) AddTagToPost(ctx context.Context, arg models.AddTagToPostParams) error {
	if m.MockAddTagToPost != nil {
		return m.MockAddTagToPost(ctx, arg)
	}
	return fmt.Errorf("AddTagToPost not implemented")
}

func (m *mockRepository) BulkPublishScheduledPosts(ctx context.Context) ([]models.Post, error) {
	if m.MockBulkPublishScheduledPosts != nil {
		return m.MockBulkPublishScheduledPosts(ctx)
	}
	return nil, fmt.Errorf("BulkPublishScheduledPosts not implemented")
}

func (m *mockRepository) ClearPostTags(ctx context.Context, postID int64) error {
	if m.MockClearPostTags != nil {
		return m.MockClearPostTags(ctx, postID)
	}
	return fmt.Errorf("ClearPostTags not implemented")
}

func (m *mockRepository) ClearTagRelationships(ctx context.Context, arg models.ClearTagRelationshipsParams) error {
	if m.MockClearTagRelationships != nil {
		return m.MockClearTagRelationships(ctx, arg)
	}
	return fmt.Errorf("ClearTagRelationships not implemented")
}

func (m *mockRepository) CountMedia(ctx context.Context, arg models.CountMediaParams) (int64, error) {
	if m.MockCountMedia != nil {
		return m.MockCountMedia(ctx, arg)
	}
	return 0, fmt.Errorf("CountMedia not implemented")
}

func (m *mockRepository) CountPosts(ctx context.Context, arg models.CountPostsParams) (int64, error) {
	if m.MockCountPosts != nil {
		return m.MockCountPosts(ctx, arg)
	}
	return 0, fmt.Errorf("CountPosts not implemented")
}

func (m *mockRepository) CountPostsByTag(ctx context.Context, arg models.CountPostsByTagParams) (int64, error) {
	if m.MockCountPostsByTag != nil {
		return m.MockCountPostsByTag(ctx, arg)
	}
	return 0, fmt.Errorf("CountPostsByTag not implemented")
}

func (m *mockRepository) CountTrashedPosts(ctx context.Context) (int64, error) {
	if m.MockCountTrashedPosts != nil {
		return m.MockCountTrashedPosts(ctx)
	}
	return 0, fmt.Errorf("CountTrashedPosts not implemented")
}

func (m *mockRepository) CreateAPIKey(ctx context.Context, arg models.CreateAPIKeyParams) (models.ApiKey, error) {
	if m.MockCreateAPIKey != nil {
		return m.MockCreateAPIKey(ctx, arg)
	}
	return models.ApiKey{}, fmt.Errorf("CreateAPIKey not implemented")
}

func (m *mockRepository) CreateMedia(ctx context.Context, arg models.CreateMediaParams) (models.Medium, error) {
	if m.MockCreateMedia != nil {
		return m.MockCreateMedia(ctx, arg)
	}
	return models.Medium{}, fmt.Errorf("CreateMedia not implemented")
}

func (m *mockRepository) CreatePost(ctx context.Context, arg models.CreatePostParams) (models.Post, error) {
	if m.MockCreatePost != nil {
		return m.MockCreatePost(ctx, arg)
	}
	return models.Post{}, fmt.Errorf("CreatePost not implemented")
}

func (m *mockRepository) CreateSession(ctx context.Context, arg models.CreateSessionParams) (models.Session, error) {
	if m.MockCreateSession != nil {
		return m.MockCreateSession(ctx, arg)
	}
	return models.Session{}, fmt.Errorf("CreateSession not implemented")
}

func (m *mockRepository) CreateTag(ctx context.Context, arg models.CreateTagParams) (models.Tag, error) {
	if m.MockCreateTag != nil {
		return m.MockCreateTag(ctx, arg)
	}
	return models.Tag{}, fmt.Errorf("CreateTag not implemented")
}

func (m *mockRepository) CreateUser(ctx context.Context, arg models.CreateUserParams) (models.User, error) {
	if m.MockCreateUser != nil {
		return m.MockCreateUser(ctx, arg)
	}
	return models.User{}, fmt.Errorf("CreateUser not implemented")
}

func (m *mockRepository) DeleteAPIKey(ctx context.Context, arg models.DeleteAPIKeyParams) error {
	if m.MockDeleteAPIKey != nil {
		return m.MockDeleteAPIKey(ctx, arg)
	}
	return fmt.Errorf("DeleteAPIKey not implemented")
}

func (m *mockRepository) DeleteExpiredSessions(ctx context.Context) error {
	if m.MockDeleteExpiredSessions != nil {
		return m.MockDeleteExpiredSessions(ctx)
	}
	return fmt.Errorf("DeleteExpiredSessions not implemented")
}

func (m *mockRepository) DeleteMedia(ctx context.Context, id int64) error {
	if m.MockDeleteMedia != nil {
		return m.MockDeleteMedia(ctx, id)
	}
	return fmt.Errorf("DeleteMedia not implemented")
}

func (m *mockRepository) DeletePost(ctx context.Context, arg models.DeletePostParams) error {
	if m.MockDeletePost != nil {
		return m.MockDeletePost(ctx, arg)
	}
	return fmt.Errorf("DeletePost not implemented")
}

func (m *mockRepository) DeletePostTagsByTag(ctx context.Context, tagID int64) error {
	if m.MockDeletePostTagsByTag != nil {
		return m.MockDeletePostTagsByTag(ctx, tagID)
	}
	return fmt.Errorf("DeletePostTagsByTag not implemented")
}

func (m *mockRepository) DeleteSession(ctx context.Context, arg models.DeleteSessionParams) error {
	if m.MockDeleteSession != nil {
		return m.MockDeleteSession(ctx, arg)
	}
	return fmt.Errorf("DeleteSession not implemented")
}

func (m *mockRepository) DeleteSetting(ctx context.Context, key string) error {
	if m.MockDeleteSetting != nil {
		return m.MockDeleteSetting(ctx, key)
	}
	return fmt.Errorf("DeleteSetting not implemented")
}

func (m *mockRepository) DeleteTag(ctx context.Context, id int64) error {
	if m.MockDeleteTag != nil {
		return m.MockDeleteTag(ctx, id)
	}
	return fmt.Errorf("DeleteTag not implemented")
}

func (m *mockRepository) DeleteUserSessions(ctx context.Context, arg models.DeleteUserSessionsParams) error {
	if m.MockDeleteUserSessions != nil {
		return m.MockDeleteUserSessions(ctx, arg)
	}
	return fmt.Errorf("DeleteUserSessions not implemented")
}

func (m *mockRepository) GetAPIKeyByHash(ctx context.Context, keyHash string) (models.GetAPIKeyByHashRow, error) {
	if m.MockGetAPIKeyByHash != nil {
		return m.MockGetAPIKeyByHash(ctx, keyHash)
	}
	return models.GetAPIKeyByHashRow{}, fmt.Errorf("GetAPIKeyByHash not implemented")
}

func (m *mockRepository) GetFirstUser(ctx context.Context) (models.User, error) {
	if m.MockGetFirstUser != nil {
		return m.MockGetFirstUser(ctx)
	}
	return models.User{}, fmt.Errorf("GetFirstUser not implemented")
}

func (m *mockRepository) GetMedia(ctx context.Context, id int64) (models.Medium, error) {
	if m.MockGetMedia != nil {
		return m.MockGetMedia(ctx, id)
	}
	return models.Medium{}, fmt.Errorf("GetMedia not implemented")
}

func (m *mockRepository) GetMediaByChecksum(ctx context.Context, checksum string) (models.Medium, error) {
	if m.MockGetMediaByChecksum != nil {
		return m.MockGetMediaByChecksum(ctx, checksum)
	}
	return models.Medium{}, fmt.Errorf("GetMediaByChecksum not implemented")
}

func (m *mockRepository) GetMediaByPostID(ctx context.Context, postID sql.NullInt64) ([]models.Medium, error) {
	if m.MockGetMediaByPostID != nil {
		return m.MockGetMediaByPostID(ctx, postID)
	}
	return nil, fmt.Errorf("GetMediaByPostID not implemented")
}

func (m *mockRepository) GetPost(ctx context.Context, id int64) (models.Post, error) {
	if m.MockGetPost != nil {
		return m.MockGetPost(ctx, id)
	}
	return models.Post{}, fmt.Errorf("GetPost not implemented")
}

func (m *mockRepository) GetPostAnalytics(ctx context.Context) (models.GetPostAnalyticsRow, error) {
	if m.MockGetPostAnalytics != nil {
		return m.MockGetPostAnalytics(ctx)
	}
	return models.GetPostAnalyticsRow{}, fmt.Errorf("GetPostAnalytics not implemented")
}

func (m *mockRepository) GetPostBySlug(ctx context.Context, slug string) (models.Post, error) {
	if m.MockGetPostBySlug != nil {
		return m.MockGetPostBySlug(ctx, slug)
	}
	return models.Post{}, fmt.Errorf("GetPostBySlug not implemented")
}

func (m *mockRepository) GetPostsByTag(ctx context.Context, arg models.GetPostsByTagParams) ([]models.Post, error) {
	if m.MockGetPostsByTag != nil {
		return m.MockGetPostsByTag(ctx, arg)
	}
	return nil, fmt.Errorf("GetPostsByTag not implemented")
}

func (m *mockRepository) GetSecret(ctx context.Context, key string) (models.BlogSecret, error) {
	if m.MockGetSecret != nil {
		return m.MockGetSecret(ctx, key)
	}
	return models.BlogSecret{}, fmt.Errorf("GetSecret not implemented")
}

func (m *mockRepository) GetSessionByToken(ctx context.Context, token string) (models.GetSessionByTokenRow, error) {
	if m.MockGetSessionByToken != nil {
		return m.MockGetSessionByToken(ctx, token)
	}
	return models.GetSessionByTokenRow{}, fmt.Errorf("GetSessionByToken not implemented")
}

func (m *mockRepository) GetSetting(ctx context.Context, key string) (models.BlogSetting, error) {
	if m.MockGetSetting != nil {
		return m.MockGetSetting(ctx, key)
	}
	return models.BlogSetting{}, fmt.Errorf("GetSetting not implemented")
}

func (m *mockRepository) GetStorageUsage(ctx context.Context) (sql.NullFloat64, error) {
	if m.MockGetStorageUsage != nil {
		return m.MockGetStorageUsage(ctx)
	}
	return sql.NullFloat64{}, fmt.Errorf("GetStorageUsage not implemented")
}

func (m *mockRepository) GetTag(ctx context.Context, id int64) (models.Tag, error) {
	if m.MockGetTag != nil {
		return m.MockGetTag(ctx, id)
	}
	return models.Tag{}, fmt.Errorf("GetTag not implemented")
}

func (m *mockRepository) GetTagBySlug(ctx context.Context, slug string) (models.Tag, error) {
	if m.MockGetTagBySlug != nil {
		return m.MockGetTagBySlug(ctx, slug)
	}
	return models.Tag{}, fmt.Errorf("GetTagBySlug not implemented")
}

func (m *mockRepository) GetTagChildren(ctx context.Context, parentID int64) ([]models.Tag, error) {
	if m.MockGetTagChildren != nil {
		return m.MockGetTagChildren(ctx, parentID)
	}
	return nil, fmt.Errorf("GetTagChildren not implemented")
}

func (m *mockRepository) GetTagParents(ctx context.Context, childID int64) ([]models.Tag, error) {
	if m.MockGetTagParents != nil {
		return m.MockGetTagParents(ctx, childID)
	}
	return nil, fmt.Errorf("GetTagParents not implemented")
}

func (m *mockRepository) GetTagsForPost(ctx context.Context, postID int64) ([]models.Tag, error) {
	if m.MockGetTagsForPost != nil {
		return m.MockGetTagsForPost(ctx, postID)
	}
	return nil, fmt.Errorf("GetTagsForPost not implemented")
}

func (m *mockRepository) GetUser(ctx context.Context, id int64) (models.User, error) {
	if m.MockGetUser != nil {
		return m.MockGetUser(ctx, id)
	}
	return models.User{}, fmt.Errorf("GetUser not implemented")
}

func (m *mockRepository) GetUserByEmail(ctx context.Context, email string) (models.User, error) {
	if m.MockGetUserByEmail != nil {
		return m.MockGetUserByEmail(ctx, email)
	}
	return models.User{}, fmt.Errorf("GetUserByEmail not implemented")
}

func (m *mockRepository) GetUserByUsername(ctx context.Context, username string) (models.User, error) {
	if m.MockGetUserByUsername != nil {
		return m.MockGetUserByUsername(ctx, username)
	}
	return models.User{}, fmt.Errorf("GetUserByUsername not implemented")
}

func (m *mockRepository) GetUserSessions(ctx context.Context, userID int64) ([]models.Session, error) {
	if m.MockGetUserSessions != nil {
		return m.MockGetUserSessions(ctx, userID)
	}
	return nil, fmt.Errorf("GetUserSessions not implemented")
}

func (m *mockRepository) IncrementPostViewCount(ctx context.Context, id int64) error {
	if m.MockIncrementPostViewCount != nil {
		return m.MockIncrementPostViewCount(ctx, id)
	}
	return fmt.Errorf("IncrementPostViewCount not implemented")
}

func (m *mockRepository) ListAPIKeysByUser(ctx context.Context, userID int64) ([]models.ApiKey, error) {
	if m.MockListAPIKeysByUser != nil {
		return m.MockListAPIKeysByUser(ctx, userID)
	}
	return nil, fmt.Errorf("ListAPIKeysByUser not implemented")
}

func (m *mockRepository) ListMedia(ctx context.Context, arg models.ListMediaParams) ([]models.Medium, error) {
	if m.MockListMedia != nil {
		return m.MockListMedia(ctx, arg)
	}
	return nil, fmt.Errorf("ListMedia not implemented")
}

func (m *mockRepository) ListPosts(ctx context.Context, arg models.ListPostsParams) ([]models.Post, error) {
	if m.MockListPosts != nil {
		return m.MockListPosts(ctx, arg)
	}
	return nil, fmt.Errorf("ListPosts not implemented")
}

func (m *mockRepository) ListPostsByViews(ctx context.Context, arg models.ListPostsByViewsParams) ([]models.Post, error) {
	if m.MockListPostsByViews != nil {
		return m.MockListPostsByViews(ctx, arg)
	}
	return nil, fmt.Errorf("ListPostsByViews not implemented")
}

func (m *mockRepository) ListSettings(ctx context.Context) ([]models.BlogSetting, error) {
	if m.MockListSettings != nil {
		return m.MockListSettings(ctx)
	}
	return nil, fmt.Errorf("ListSettings not implemented")
}

func (m *mockRepository) ListTags(ctx context.Context, includeEmptyFilter interface{}) ([]models.Tag, error) {
	if m.MockListTags != nil {
		return m.MockListTags(ctx, includeEmptyFilter)
	}
	return nil, fmt.Errorf("ListTags not implemented")
}

func (m *mockRepository) ListTrashedPosts(ctx context.Context, arg models.ListTrashedPostsParams) ([]models.Post, error) {
	if m.MockListTrashedPosts != nil {
		return m.MockListTrashedPosts(ctx, arg)
	}
	return nil, fmt.Errorf("ListTrashedPosts not implemented")
}

func (m *mockRepository) MergePostTags(ctx context.Context, arg models.MergePostTagsParams) error {
	if m.MockMergePostTags != nil {
		return m.MockMergePostTags(ctx, arg)
	}
	return fmt.Errorf("MergePostTags not implemented")
}

func (m *mockRepository) MergeTagChildren(ctx context.Context, arg models.MergeTagChildrenParams) error {
	if m.MockMergeTagChildren != nil {
		return m.MockMergeTagChildren(ctx, arg)
	}
	return fmt.Errorf("MergeTagChildren not implemented")
}

func (m *mockRepository) MergeTagParents(ctx context.Context, arg models.MergeTagParentsParams) error {
	if m.MockMergeTagParents != nil {
		return m.MockMergeTagParents(ctx, arg)
	}
	return fmt.Errorf("MergeTagParents not implemented")
}

func (m *mockRepository) MergeTags(ctx context.Context, winnerID, loserID int64) error {
	if m.MockMergeTags != nil {
		return m.MockMergeTags(ctx, winnerID, loserID)
	}
	return fmt.Errorf("MergeTags not implemented")
}

func (m *mockRepository) PublishPost(ctx context.Context, id int64) (models.Post, error) {
	if m.MockPublishPost != nil {
		return m.MockPublishPost(ctx, id)
	}
	return models.Post{}, fmt.Errorf("PublishPost not implemented")
}

func (m *mockRepository) RemoveTagFromPost(ctx context.Context, arg models.RemoveTagFromPostParams) error {
	if m.MockRemoveTagFromPost != nil {
		return m.MockRemoveTagFromPost(ctx, arg)
	}
	return fmt.Errorf("RemoveTagFromPost not implemented")
}

func (m *mockRepository) RemoveTagRelationship(ctx context.Context, arg models.RemoveTagRelationshipParams) error {
	if m.MockRemoveTagRelationship != nil {
		return m.MockRemoveTagRelationship(ctx, arg)
	}
	return fmt.Errorf("RemoveTagRelationship not implemented")
}

func (m *mockRepository) RestorePost(ctx context.Context, arg models.RestorePostParams) error {
	if m.MockRestorePost != nil {
		return m.MockRestorePost(ctx, arg)
	}
	return fmt.Errorf("RestorePost not implemented")
}

func (m *mockRepository) RevokeAPIKey(ctx context.Context, arg models.RevokeAPIKeyParams) error {
	if m.MockRevokeAPIKey != nil {
		return m.MockRevokeAPIKey(ctx, arg)
	}
	return fmt.Errorf("RevokeAPIKey not implemented")
}

func (m *mockRepository) SetPostPreviewToken(ctx context.Context, arg models.SetPostPreviewTokenParams) error {
	if m.MockSetPostPreviewToken != nil {
		return m.MockSetPostPreviewToken(ctx, arg)
	}
	return fmt.Errorf("SetPostPreviewToken not implemented")
}

func (m *mockRepository) SoftDeletePost(ctx context.Context, arg models.SoftDeletePostParams) error {
	if m.MockSoftDeletePost != nil {
		return m.MockSoftDeletePost(ctx, arg)
	}
	return fmt.Errorf("SoftDeletePost not implemented")
}

func (m *mockRepository) TouchAPIKeyLastUsed(ctx context.Context, id int64) error {
	if m.MockTouchAPIKeyLastUsed != nil {
		return m.MockTouchAPIKeyLastUsed(ctx, id)
	}
	return fmt.Errorf("TouchAPIKeyLastUsed not implemented")
}

func (m *mockRepository) UpdateAllTagPostCounts(ctx context.Context) error {
	if m.MockUpdateAllTagPostCounts != nil {
		return m.MockUpdateAllTagPostCounts(ctx)
	}
	return fmt.Errorf("UpdateAllTagPostCounts not implemented")
}

func (m *mockRepository) UpdateMedia(ctx context.Context, arg models.UpdateMediaParams) (models.Medium, error) {
	if m.MockUpdateMedia != nil {
		return m.MockUpdateMedia(ctx, arg)
	}
	return models.Medium{}, fmt.Errorf("UpdateMedia not implemented")
}

func (m *mockRepository) UpdateMediaFilename(ctx context.Context, arg models.UpdateMediaFilenameParams) (models.Medium, error) {
	if m.MockUpdateMediaFilename != nil {
		return m.MockUpdateMediaFilename(ctx, arg)
	}
	return models.Medium{}, fmt.Errorf("UpdateMediaFilename not implemented")
}

func (m *mockRepository) UpdateMediaMetadata(ctx context.Context, arg models.UpdateMediaMetadataParams) (models.Medium, error) {
	if m.MockUpdateMediaMetadata != nil {
		return m.MockUpdateMediaMetadata(ctx, arg)
	}
	return models.Medium{}, fmt.Errorf("UpdateMediaMetadata not implemented")
}

func (m *mockRepository) UpdatePost(ctx context.Context, arg models.UpdatePostParams) (models.Post, error) {
	if m.MockUpdatePost != nil {
		return m.MockUpdatePost(ctx, arg)
	}
	return models.Post{}, fmt.Errorf("UpdatePost not implemented")
}

func (m *mockRepository) UpdateSessionActivity(ctx context.Context, id int64) error {
	if m.MockUpdateSessionActivity != nil {
		return m.MockUpdateSessionActivity(ctx, id)
	}
	return fmt.Errorf("UpdateSessionActivity not implemented")
}

func (m *mockRepository) UpdateSetting(ctx context.Context, arg models.UpdateSettingParams) (models.BlogSetting, error) {
	if m.MockUpdateSetting != nil {
		return m.MockUpdateSetting(ctx, arg)
	}
	return models.BlogSetting{}, fmt.Errorf("UpdateSetting not implemented")
}

func (m *mockRepository) UpdateTag(ctx context.Context, arg models.UpdateTagParams) (models.Tag, error) {
	if m.MockUpdateTag != nil {
		return m.MockUpdateTag(ctx, arg)
	}
	return models.Tag{}, fmt.Errorf("UpdateTag not implemented")
}

func (m *mockRepository) UpdateTagPostCount(ctx context.Context, id int64) error {
	if m.MockUpdateTagPostCount != nil {
		return m.MockUpdateTagPostCount(ctx, id)
	}
	return fmt.Errorf("UpdateTagPostCount not implemented")
}

func (m *mockRepository) UpdateUserLogin(ctx context.Context, id int64) error {
	if m.MockUpdateUserLogin != nil {
		return m.MockUpdateUserLogin(ctx, id)
	}
	return fmt.Errorf("UpdateUserLogin not implemented")
}

func (m *mockRepository) UpdateUserPassword(ctx context.Context, arg models.UpdateUserPasswordParams) error {
	if m.MockUpdateUserPassword != nil {
		return m.MockUpdateUserPassword(ctx, arg)
	}
	return fmt.Errorf("UpdateUserPassword not implemented")
}

func (m *mockRepository) UpsertSecret(ctx context.Context, arg models.UpsertSecretParams) error {
	if m.MockUpsertSecret != nil {
		return m.MockUpsertSecret(ctx, arg)
	}
	return fmt.Errorf("UpsertSecret not implemented")
}

func (m *mockRepository) UpdatePostInstagramStatus(ctx context.Context, arg models.UpdatePostInstagramStatusParams) error {
	if m.MockUpdatePostInstagramStatus != nil {
		return m.MockUpdatePostInstagramStatus(ctx, arg)
	}
	return nil
}

func (m *mockRepository) WithdrawPost(ctx context.Context, id int64) (models.Post, error) {
	if m.MockWithdrawPost != nil {
		return m.MockWithdrawPost(ctx, id)
	}
	return models.Post{}, fmt.Errorf("WithdrawPost not implemented")
}

// Implementation of Repository methods

func (m *mockRepository) Close() error {
	if m.MockClose != nil {
		return m.MockClose()
	}
	return fmt.Errorf("Close not implemented")
}

func (m *mockRepository) DB() *sql.DB {
	if m.MockDB != nil {
		return m.MockDB()
	}
	return nil
}

func (m *mockRepository) DeleteSecret(ctx context.Context, key string) error {
	if m.MockDeleteSecret != nil {
		return m.MockDeleteSecret(ctx, key)
	}
	return fmt.Errorf("DeleteSecret not implemented")
}

func (m *mockRepository) CreateWebAuthnCredential(ctx context.Context, userID int64, credID, pubKey, aaguid []byte, signCount uint32, backupEligible, backupState bool) (*repository.WebAuthnCredential, error) {
	if m.MockCreateWebAuthnCredential != nil {
		return m.MockCreateWebAuthnCredential(ctx, userID, credID, pubKey, aaguid, signCount, backupEligible, backupState)
	}
	return nil, fmt.Errorf("CreateWebAuthnCredential not implemented")
}

func (m *mockRepository) GetWebAuthnCredentialsByUserID(ctx context.Context, userID int64) ([]repository.WebAuthnCredential, error) {
	if m.MockGetWebAuthnCredentialsByUserID != nil {
		return m.MockGetWebAuthnCredentialsByUserID(ctx, userID)
	}
	return nil, fmt.Errorf("GetWebAuthnCredentialsByUserID not implemented")
}

func (m *mockRepository) GetWebAuthnCredentialByCredentialID(ctx context.Context, credID []byte) (*repository.WebAuthnCredential, error) {
	if m.MockGetWebAuthnCredentialByCredentialID != nil {
		return m.MockGetWebAuthnCredentialByCredentialID(ctx, credID)
	}
	return nil, fmt.Errorf("GetWebAuthnCredentialByCredentialID not implemented")
}

func (m *mockRepository) DeleteWebAuthnCredentialByUserID(ctx context.Context, userID int64) error {
	if m.MockDeleteWebAuthnCredentialByUserID != nil {
		return m.MockDeleteWebAuthnCredentialByUserID(ctx, userID)
	}
	return fmt.Errorf("DeleteWebAuthnCredentialByUserID not implemented")
}

func (m *mockRepository) UpdateWebAuthnCredential(ctx context.Context, credID []byte, signCount uint32, backupState bool) error {
	if m.MockUpdateWebAuthnCredential != nil {
		return m.MockUpdateWebAuthnCredential(ctx, credID, signCount, backupState)
	}
	return fmt.Errorf("UpdateWebAuthnCredential not implemented")
}

func (m *mockRepository) GetPublishedPostsForFeed(ctx context.Context, limit int) ([]models.Post, error) {
	if m.MockGetPublishedPostsForFeed != nil {
		return m.MockGetPublishedPostsForFeed(ctx, limit)
	}
	return nil, fmt.Errorf("GetPublishedPostsForFeed not implemented")
}

func (m *mockRepository) GetPublishedPostsForSitemap(ctx context.Context) ([]struct {
	Slug      string
	UpdatedAt time.Time
}, error) {
	if m.MockGetPublishedPostsForSitemap != nil {
		return m.MockGetPublishedPostsForSitemap(ctx)
	}
	return nil, fmt.Errorf("GetPublishedPostsForSitemap not implemented")
}

func (m *mockRepository) GetPublicTagsForSitemap(ctx context.Context) ([]struct {
	ID   int64
	Slug string
}, error) {
	if m.MockGetPublicTagsForSitemap != nil {
		return m.MockGetPublicTagsForSitemap(ctx)
	}
	return nil, fmt.Errorf("GetPublicTagsForSitemap not implemented")
}

func (m *mockRepository) UpsertTagLocation(ctx context.Context, tagID int64, lat, lon float64) error {
	if m.MockUpsertTagLocation != nil {
		return m.MockUpsertTagLocation(ctx, tagID, lat, lon)
	}
	return fmt.Errorf("UpsertTagLocation not implemented")
}

func (m *mockRepository) GetTagLocationsByTagIDs(ctx context.Context, tagIDs []int64) (map[int64]models.TagLocation, error) {
	if m.MockGetTagLocationsByTagIDs != nil {
		return m.MockGetTagLocationsByTagIDs(ctx, tagIDs)
	}
	return nil, fmt.Errorf("GetTagLocationsByTagIDs not implemented")
}

func (m *mockRepository) DeleteTagLocation(ctx context.Context, tagID int64) error {
	if m.MockDeleteTagLocation != nil {
		return m.MockDeleteTagLocation(ctx, tagID)
	}
	return fmt.Errorf("DeleteTagLocation not implemented")
}

func (m *mockRepository) ListOrphanedMedia(ctx context.Context, limit, offset int64) ([]models.Medium, error) {
	if m.MockListOrphanedMedia != nil {
		return m.MockListOrphanedMedia(ctx, limit, offset)
	}
	return nil, fmt.Errorf("ListOrphanedMedia not implemented")
}

func (m *mockRepository) CountOrphanedMedia(ctx context.Context) (int64, error) {
	if m.MockCountOrphanedMedia != nil {
		return m.MockCountOrphanedMedia(ctx)
	}
	return 0, fmt.Errorf("CountOrphanedMedia not implemented")
}

func (m *mockRepository) GetMediaByIDs(ctx context.Context, ids []int64) ([]models.Medium, error) {
	if m.MockGetMediaByIDs != nil {
		return m.MockGetMediaByIDs(ctx, ids)
	}
	return nil, fmt.Errorf("GetMediaByIDs not implemented")
}

func (m *mockRepository) DeleteMediaByIDs(ctx context.Context, ids []int64) error {
	if m.MockDeleteMediaByIDs != nil {
		return m.MockDeleteMediaByIDs(ctx, ids)
	}
	return fmt.Errorf("DeleteMediaByIDs not implemented")
}

func (m *mockRepository) ListOrphanedMediaByPage(ctx context.Context, limit, offset int64) ([]models.Medium, int64, error) {
	if m.MockListOrphanedMediaByPage != nil {
		return m.MockListOrphanedMediaByPage(ctx, limit, offset)
	}
	return nil, 0, fmt.Errorf("ListOrphanedMediaByPage not implemented")
}

func (m *mockRepository) ListMediaFolders(ctx context.Context, fileType string) ([]repository.MediaFolder, error) {
	if m.MockListMediaFolders != nil {
		return m.MockListMediaFolders(ctx, fileType)
	}
	return nil, fmt.Errorf("ListMediaFolders not implemented")
}

func (m *mockRepository) ListMediaFiltered(ctx context.Context, fileType, folder string, limit, offset int64) ([]models.Medium, error) {
	if m.MockListMediaFiltered != nil {
		return m.MockListMediaFiltered(ctx, fileType, folder, limit, offset)
	}
	return nil, fmt.Errorf("ListMediaFiltered not implemented")
}

func (m *mockRepository) CountMediaFiltered(ctx context.Context, fileType, folder string) (int64, error) {
	if m.MockCountMediaFiltered != nil {
		return m.MockCountMediaFiltered(ctx, fileType, folder)
	}
	return 0, fmt.Errorf("CountMediaFiltered not implemented")
}

func (m *mockRepository) GetMediaByPath(ctx context.Context, originalPath string) (models.Medium, error) {
	if m.MockGetMediaByPath != nil {
		return m.MockGetMediaByPath(ctx, originalPath)
	}
	return models.Medium{}, fmt.Errorf("GetMediaByPath not implemented")
}

func (m *mockRepository) SetMediaPublic(ctx context.Context, mediaID int64, isPublic bool, postID *int64) error {
	if m.MockSetMediaPublic != nil {
		return m.MockSetMediaPublic(ctx, mediaID, isPublic, postID)
	}
	return fmt.Errorf("SetMediaPublic not implemented")
}

func (m *mockRepository) GetAllMediaPaths(ctx context.Context) ([]models.Medium, error) {
	if m.MockGetAllMediaPaths != nil {
		return m.MockGetAllMediaPaths(ctx)
	}
	return nil, fmt.Errorf("GetAllMediaPaths not implemented")
}

func (m *mockRepository) GetMediaByPaths(ctx context.Context, paths []string) ([]models.Medium, error) {
	if m.MockGetMediaByPaths != nil {
		return m.MockGetMediaByPaths(ctx, paths)
	}
	return nil, fmt.Errorf("GetMediaByPaths not implemented")
}

func (m *mockRepository) GetStorageStats(ctx context.Context) (repository.StorageStats, error) {
	if m.MockGetStorageStats != nil {
		return m.MockGetStorageStats(ctx)
	}
	return repository.StorageStats{}, fmt.Errorf("GetStorageStats not implemented")
}

func (m *mockRepository) GetMigrations(ctx context.Context) ([]repository.MigrationRecord, error) {
	if m.MockGetMigrations != nil {
		return m.MockGetMigrations(ctx)
	}
	return nil, fmt.Errorf("GetMigrations not implemented")
}

func (m *mockRepository) ApplyMigration(ctx context.Context, name, sql string) error {
	if m.MockApplyMigration != nil {
		return m.MockApplyMigration(ctx, name, sql)
	}
	return fmt.Errorf("ApplyMigration not implemented")
}

func (m *mockRepository) MigrateFlagsToSystemTags(ctx context.Context) error {
	if m.MockMigrateFlagsToSystemTags != nil {
		return m.MockMigrateFlagsToSystemTags(ctx)
	}
	return fmt.Errorf("MigrateFlagsToSystemTags not implemented")
}

func (m *mockRepository) RebuildTagsTableDropBooleans(ctx context.Context) error {
	if m.MockRebuildTagsTableDropBooleans != nil {
		return m.MockRebuildTagsTableDropBooleans(ctx)
	}
	return fmt.Errorf("RebuildTagsTableDropBooleans not implemented")
}

func (m *mockRepository) EnsureSystemTags(ctx context.Context) error {
	if m.MockEnsureSystemTags != nil {
		return m.MockEnsureSystemTags(ctx)
	}
	return fmt.Errorf("EnsureSystemTags not implemented")
}

func (m *mockRepository) MigrateTagFlagsFromSystemTags(ctx context.Context) error {
	if m.MockMigrateTagFlagsFromSystemTags != nil {
		return m.MockMigrateTagFlagsFromSystemTags(ctx)
	}
	return nil
}

func (m *mockRepository) ListPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.ListPostsParams) ([]models.Post, error) {
	if m.MockListPostsInYearRange != nil {
		return m.MockListPostsInYearRange(ctx, fromYear, toYear, arg)
	}
	return nil, fmt.Errorf("ListPostsInYearRange not implemented")
}

func (m *mockRepository) CountPostsInYearRange(ctx context.Context, fromYear, toYear int, arg models.CountPostsParams) (int64, error) {
	if m.MockCountPostsInYearRange != nil {
		return m.MockCountPostsInYearRange(ctx, fromYear, toYear, arg)
	}
	return 0, fmt.Errorf("CountPostsInYearRange not implemented")
}

func (m *mockRepository) ListPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool, limit, offset int64) ([]models.Post, error) {
	if m.MockListPostsWithSearch != nil {
		return m.MockListPostsWithSearch(ctx, statusFilter, status, featuredFilter, includeDrafts, includeHidden, search, tag, onlyPages, limit, offset)
	}
	return nil, fmt.Errorf("ListPostsWithSearch not implemented")
}

func (m *mockRepository) CountPostsWithSearch(ctx context.Context, statusFilter bool, status string, featuredFilter bool, includeDrafts bool, includeHidden bool, search string, tag string, onlyPages bool) (int64, error) {
	if m.MockCountPostsWithSearch != nil {
		return m.MockCountPostsWithSearch(ctx, statusFilter, status, featuredFilter, includeDrafts, includeHidden, search, tag, onlyPages)
	}
	return 0, fmt.Errorf("CountPostsWithSearch not implemented")
}

func (m *mockRepository) GetPostByPreviewToken(ctx context.Context, token string) (models.Post, error) {
	if m.MockGetPostByPreviewToken != nil {
		return m.MockGetPostByPreviewToken(ctx, token)
	}
	return models.Post{}, fmt.Errorf("GetPostByPreviewToken not implemented")
}

func (m *mockRepository) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *repository.PostNavItem, err error) {
	if m.MockGetPostNavigation != nil {
		return m.MockGetPostNavigation(ctx, postID, publicOnly)
	}
	return nil, nil, fmt.Errorf("GetPostNavigation not implemented")
}

func (m *mockRepository) ReplacePostContentPath(ctx context.Context, oldPath, newPath string) (int64, error) {
	if m.MockReplacePostContentPath != nil {
		return m.MockReplacePostContentPath(ctx, oldPath, newPath)
	}
	return 0, fmt.Errorf("ReplacePostContentPath not implemented")
}

func (m *mockRepository) UpdatePostThumbnailPath(ctx context.Context, oldPath, newPath string) (int64, error) {
	if m.MockUpdatePostThumbnailPath != nil {
		return m.MockUpdatePostThumbnailPath(ctx, oldPath, newPath)
	}
	return 0, fmt.Errorf("UpdatePostThumbnailPath not implemented")
}

func (m *mockRepository) ListPublishedPostStubs(ctx context.Context) ([]repository.PostStub, error) {
	if m.MockListPublishedPostStubs != nil {
		return m.MockListPublishedPostStubs(ctx)
	}
	return nil, fmt.Errorf("ListPublishedPostStubs not implemented")
}

func (m *mockRepository) ListPostNodesForGraph(ctx context.Context, publishedOnly bool) ([]repository.GraphPostNode, error) {
	if m.MockListPostNodesForGraph != nil {
		return m.MockListPostNodesForGraph(ctx, publishedOnly)
	}
	return nil, fmt.Errorf("ListPostNodesForGraph not implemented")
}

func (m *mockRepository) GetPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error) {
	if m.MockGetPostsByTagIDs != nil {
		return m.MockGetPostsByTagIDs(ctx, tagIDs, publishedOnly, includeDrafts, includeHidden, limit, offset)
	}
	return nil, fmt.Errorf("GetPostsByTagIDs not implemented")
}

func (m *mockRepository) CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error) {
	if m.MockCountPostsByTagIDs != nil {
		return m.MockCountPostsByTagIDs(ctx, tagIDs, publishedOnly, includeDrafts, includeHidden)
	}
	return 0, fmt.Errorf("CountPostsByTagIDs not implemented")
}

func (m *mockRepository) GetPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool, limit, offset int64) ([]models.Post, error) {
	if m.MockGetPostsByTagIDsInYearRange != nil {
		return m.MockGetPostsByTagIDsInYearRange(ctx, tagIDs, fromYear, toYear, publishedOnly, includeDrafts, includeHidden, limit, offset)
	}
	return nil, fmt.Errorf("GetPostsByTagIDsInYearRange not implemented")
}

func (m *mockRepository) CountPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly bool, includeDrafts bool, includeHidden bool) (int64, error) {
	if m.MockCountPostsByTagIDsInYearRange != nil {
		return m.MockCountPostsByTagIDsInYearRange(ctx, tagIDs, fromYear, toYear, publishedOnly, includeDrafts, includeHidden)
	}
	return 0, fmt.Errorf("CountPostsByTagIDsInYearRange not implemented")
}

func (m *mockRepository) GetAllPublishedPostContents(ctx context.Context) ([]repository.PostContentRow, error) {
	if m.MockGetAllPublishedPostContents != nil {
		return m.MockGetAllPublishedPostContents(ctx)
	}
	return nil, fmt.Errorf("GetAllPublishedPostContents not implemented")
}

func (m *mockRepository) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	if m.MockGetHierarchicalPostCounts != nil {
		return m.MockGetHierarchicalPostCounts(ctx, publishedOnly)
	}
	return nil, fmt.Errorf("GetHierarchicalPostCounts not implemented")
}

func (m *mockRepository) GetSystemStats(ctx context.Context) (repository.SystemStats, error) {
	if m.MockGetSystemStats != nil {
		return m.MockGetSystemStats(ctx)
	}
	return repository.SystemStats{}, fmt.Errorf("GetSystemStats not implemented")
}

func (m *mockRepository) BackupDB(ctx context.Context, destPath string) error {
	if m.MockBackupDB != nil {
		return m.MockBackupDB(ctx, destPath)
	}
	return fmt.Errorf("BackupDB not implemented")
}

func (m *mockRepository) SearchTags(ctx context.Context, query string, limit int) ([]models.Tag, error) {
	if m.MockSearchTags != nil {
		return m.MockSearchTags(ctx, query, limit)
	}
	return nil, fmt.Errorf("SearchTags not implemented")
}

func (m *mockRepository) GetTagAncestors(ctx context.Context, tagID int64) ([]models.Tag, error) {
	if m.MockGetTagAncestors != nil {
		return m.MockGetTagAncestors(ctx, tagID)
	}
	return nil, fmt.Errorf("GetTagAncestors not implemented")
}

func (m *mockRepository) GetTagDescendants(ctx context.Context, tagID int64) ([]models.Tag, error) {
	if m.MockGetTagDescendants != nil {
		return m.MockGetTagDescendants(ctx, tagID)
	}
	return nil, fmt.Errorf("GetTagDescendants not implemented")
}

func (m *mockRepository) GetCoOccurringTags(ctx context.Context, tagID int64, publicOnly bool) ([]models.Tag, error) {
	if m.MockGetCoOccurringTags != nil {
		return m.MockGetCoOccurringTags(ctx, tagID, publicOnly)
	}
	return nil, fmt.Errorf("GetCoOccurringTags not implemented")
}

func (m *mockRepository) GetAllTagRelationships(ctx context.Context) ([]repository.TagRelationship, error) {
	if m.MockGetAllTagRelationships != nil {
		return m.MockGetAllTagRelationships(ctx)
	}
	return nil, fmt.Errorf("GetAllTagRelationships not implemented")
}

func (m *mockRepository) ClearTagParents(ctx context.Context, childID int64) error {
	if m.MockClearTagParents != nil {
		return m.MockClearTagParents(ctx, childID)
	}
	return fmt.Errorf("ClearTagParents not implemented")
}

func (m *mockRepository) ClearTagChildren(ctx context.Context, parentID int64) error {
	if m.MockClearTagChildren != nil {
		return m.MockClearTagChildren(ctx, parentID)
	}
	return fmt.Errorf("ClearTagChildren not implemented")
}

func (m *mockRepository) GetTagsWithoutLocation(ctx context.Context, tagIDs []int64) ([]models.Tag, error) {
	if m.MockGetTagsWithoutLocation != nil {
		return m.MockGetTagsWithoutLocation(ctx, tagIDs)
	}
	return nil, fmt.Errorf("GetTagsWithoutLocation not implemented")
}

func (m *mockRepository) FindTagsByNames(ctx context.Context, names []string) ([]models.Tag, error) {
	if m.MockFindTagsByNames != nil {
		return m.MockFindTagsByNames(ctx, names)
	}
	return nil, fmt.Errorf("FindTagsByNames not implemented")
}

func (m *mockRepository) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	if m.MockGetTagsByPostIDs != nil {
		return m.MockGetTagsByPostIDs(ctx, postIDs)
	}
	return nil, fmt.Errorf("GetTagsByPostIDs not implemented")
}

func (m *mockRepository) GetChildrenOfTag(ctx context.Context, parentID int64) ([]models.Tag, error) {
	if m.MockGetChildrenOfTag != nil {
		return m.MockGetChildrenOfTag(ctx, parentID)
	}
	return nil, fmt.Errorf("GetChildrenOfTag not implemented")
}

func (m *mockRepository) GetRootTags(ctx context.Context) ([]models.Tag, error) {
	if m.MockGetRootTags != nil {
		return m.MockGetRootTags(ctx)
	}
	return nil, fmt.Errorf("GetRootTags not implemented")
}

func (m *mockRepository) UpdateTagSortOrder(ctx context.Context, id int64, sortOrder int32) error {
	if m.MockUpdateTagSortOrder != nil {
		return m.MockUpdateTagSortOrder(ctx, id, sortOrder)
	}
	return fmt.Errorf("UpdateTagSortOrder not implemented")
}

func (m *mockRepository) UpdateEdgeSortOrder(ctx context.Context, parentID, childID int64, sortOrder int32) error {
	return nil
}

func (m *mockRepository) ListMapTagsForYearRange(ctx context.Context, fromYear, toYear int) ([]repository.MapYearRangeTag, error) {
	if m.MockListMapTagsForYearRange != nil {
		return m.MockListMapTagsForYearRange(ctx, fromYear, toYear)
	}
	return nil, fmt.Errorf("ListMapTagsForYearRange not implemented")
}

func (m *mockRepository) ListInTimelineDescendants(ctx context.Context) ([]repository.InTimelineTag, error) {
	if m.MockListInTimelineDescendants != nil {
		return m.MockListInTimelineDescendants(ctx)
	}
	return nil, fmt.Errorf("ListInTimelineDescendants not implemented")
}

func (m *mockRepository) ListInTimelineDescendantsForTag(ctx context.Context, contextTagSlug string) ([]repository.InTimelineTag, error) {
	if m.MockListInTimelineDescendantsForTag != nil {
		return m.MockListInTimelineDescendantsForTag(ctx, contextTagSlug)
	}
	return nil, fmt.Errorf("ListInTimelineDescendantsForTag not implemented")
}

func (m *mockRepository) GetLocationTagsCoOccurringWith(ctx context.Context, dateTagSlug, contextTagSlug string, limit int) ([]repository.LocationTagCoOccurrence, error) {
	if m.MockGetLocationTagsCoOccurringWith != nil {
		return m.MockGetLocationTagsCoOccurringWith(ctx, dateTagSlug, contextTagSlug, limit)
	}
	return nil, fmt.Errorf("GetLocationTagsCoOccurringWith not implemented")
}

func (m *mockRepository) GetYearTagsByLocationTagIDs(ctx context.Context, locTagIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	if m.MockGetYearTagsByLocationTagIDs != nil {
		return m.MockGetYearTagsByLocationTagIDs(ctx, locTagIDs)
	}
	return nil, fmt.Errorf("GetYearTagsByLocationTagIDs not implemented")
}

func (m *mockRepository) GetExistingInstagramIDs(ctx context.Context, ids []string) ([]string, error) {
	if m.MockGetExistingInstagramIDs != nil {
		return m.MockGetExistingInstagramIDs(ctx, ids)
	}
	return nil, nil
}

func (m *mockRepository) SetPostInstagramID(ctx context.Context, postID int64, instagramID string) error {
	if m.MockSetPostInstagramID != nil {
		return m.MockSetPostInstagramID(ctx, postID, instagramID)
	}
	return nil
}
