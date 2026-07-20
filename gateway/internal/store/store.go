// Package store is the gateway's persistence layer: one SQLite file, embedded
// migrations, and app-layer tenancy.
//
// Tenancy rule (replaces Postgres RLS): every method that reads or writes
// tenant data takes an accountID and scopes its SQL to that account. Handlers
// resolve the caller's account membership first and then only ever call
// account-scoped methods. There are no unscoped tenant-data accessors except
// the ones explicitly named ForUser/ByID-with-account.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store wraps the SQLite handle. All access goes through its methods.
type Store struct {
	db *sql.DB
}

// Open opens (creating if needed) the SQLite database at dir/lintel.db and
// applies pending migrations. (Filename matches site/docs/self-host.md +
// troubleshooting.md, which document lintel.db; there are no deployments
// yet, so the code was made to match the docs rather than the reverse.)
func Open(dir string) (*Store, error) {
	path := filepath.Join(dir, "lintel.db")
	// modernc.org/sqlite: pure Go, no CGO. WAL for concurrent readers,
	// busy_timeout so writers queue instead of failing, FKs on.
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite allows exactly one writer; a single connection sidesteps
	// SQLITE_BUSY inside transactions entirely at skeleton scale.
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	// Backfill the audit hash chain (migration 0007) for any row written
	// before the chain existed. MUST run before Open returns: the chain's
	// invariant (InsertAccessLog/WriteAdminAudit always chain off the last
	// row in rowid order) only holds if nothing can insert a fresh, already
	// current-schema row while older rows are still un-hashed — and nothing
	// can, because the server never starts accepting requests until Open
	// returns. See internal/store/audithash.go.
	if err := s.backfillHashChains(context.Background()); err != nil {
		db.Close()
		return nil, fmt.Errorf("backfill hash chains: %w", err)
	}
	return s, nil
}

// Close closes the underlying database.
func (s *Store) Close() error { return s.db.Close() }

// DBNow returns the database clock (unix seconds), proving the handle is live
// — the /health probe (backend selected now() from Postgres for the same
// purpose). A query error here is what flips /health to ok:false.
func (s *Store) DBNow(ctx context.Context) (int64, error) {
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT unixepoch()`).Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		name       TEXT PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	names, err := fs.Glob(migrationsFS, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(names)
	for _, name := range names {
		base := filepath.Base(name)
		var n int
		if err := s.db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE name = ?`, base).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		body, err := migrationsFS.ReadFile(name)
		if err != nil {
			return err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %s: %w", base, err)
		}
		if _, err := tx.Exec(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, base, now()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// now returns unix seconds; the single time convention across the schema.
func now() int64 { return time.Now().Unix() }

// NewID returns a random UUIDv4 string (crypto/rand; no external dep).
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // rand.Read on supported platforms never fails
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// ErrNotFound is returned when a row does not exist within the caller's scope.
// A row that exists but belongs to another account is indistinguishable from
// one that does not exist — that is the tenancy contract.
var ErrNotFound = sql.ErrNoRows
