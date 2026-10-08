package services

import "testing"

// BACKUP_MANAGED pins scheduled backups on and floors retention; without it
// the admin setting decides (p-hosting-ready-vyok.2).
func TestSystemService_BackupPolicy(t *testing.T) {
	self := &SystemService{}
	managed := (&SystemService{}).WithManagedBackups(true)

	for _, tc := range []struct {
		svc     *SystemService
		setting string
		want    bool
	}{
		{self, "true", true},
		{self, "false", false},
		{managed, "false", true},
		{managed, "true", true},
	} {
		if got := tc.svc.BackupEnabled(tc.setting); got != tc.want {
			t.Errorf("managed=%v BackupEnabled(%q) = %v, want %v", tc.svc.managed, tc.setting, got, tc.want)
		}
	}

	for _, tc := range []struct {
		svc        *SystemService
		keep, want int
	}{
		{self, 2, 2},
		{managed, 2, ManagedMinBackupKeep},
		{managed, 30, 30},
		{managed, 0, 0}, // keep all is already more than the floor
	} {
		if got := tc.svc.BackupKeep(tc.keep); got != tc.want {
			t.Errorf("managed=%v BackupKeep(%d) = %d, want %d", tc.svc.managed, tc.keep, got, tc.want)
		}
	}
}
