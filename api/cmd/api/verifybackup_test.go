package main

import "testing"

func TestParseVerifyBackupArgs(t *testing.T) {
	cases := []struct {
		args []string
		ok   bool
		name string
	}{
		{[]string{"verify-backup"}, true, ""},
		{[]string{"verify-backup", "backup_1.tar.gz"}, true, "backup_1.tar.gz"},
		{[]string{"point verify-backup backup_2.tar.gz"}, true, "backup_2.tar.gz"},
		{[]string{"setup"}, false, ""},
		{nil, false, ""},
	}
	for _, c := range cases {
		ok, name := parseVerifyBackupArgs(c.args)
		if ok != c.ok || name != c.name {
			t.Errorf("parseVerifyBackupArgs(%q) = %v, %q; want %v, %q", c.args, ok, name, c.ok, c.name)
		}
	}
}
