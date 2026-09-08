package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/fswatcher/fswatcher"
	"github.com/k1LoW/donegroup"
	"github.com/k1LoW/mo/internal/static"
	"github.com/k1LoW/mo/version"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type FileEntry struct {
	Name     string   `json:"name"`
	ID       string   `json:"id"`
	Path     string   `json:"path"`
	Title    string   `json:"title,omitempty"`
	Uploaded bool     `json:"uploaded,omitempty"`
	Type     FileType `json:"type"`
	content  string   // in-memory content for uploaded files
}

const headFileSizeLimit = 8192

// leadingColumns counts the indentation of line in columns, expanding tabs to
// the next 4-column tab stop (CommonMark §2.1).
func leadingColumns(line string) int {
	col := 0
	for _, c := range line {
		switch c {
		case ' ':
			col++
		case '\t':
			col = (col/4 + 1) * 4
		default:
			return col
		}
	}
	return col
}

// extractTitle returns the text of the first Markdown heading (ATX-style)
// found in content, or "" if none is found.
func extractTitle(content string) string {
	// Track the active fenced code block: fenceChar is '`' or '~' (0 = not in fence),
	// fenceLen is the opening fence length. CommonMark requires the closing fence to
	// use the same character and be at least as long as the opening fence.
	fenceChar := byte(0)
	fenceLen := 0
	for line := range strings.SplitSeq(content, "\n") {
		// CommonMark §4.6: lines with 4+ columns of leading indentation (spaces or tabs)
		// are indented code blocks and must not be parsed as headings.
		if leadingColumns(line) >= 4 {
			continue
		}
		trimmed := strings.TrimSpace(line)

		if fenceChar != 0 {
			// Inside a fenced code block: look for a matching closing fence.
			if len(trimmed) > 0 && trimmed[0] == fenceChar {
				fl := len(trimmed) - len(strings.TrimLeft(trimmed, string(fenceChar)))
				// Closing fence: same char, >= opening length, no trailing non-space.
				if fl >= fenceLen && strings.TrimLeft(trimmed[fl:], " \t") == "" {
					fenceChar = 0
					fenceLen = 0
				}
			}
			continue
		}

		// Detect fence opening: 3+ consecutive backticks or tildes.
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			fc := trimmed[0]
			fl := len(trimmed) - len(strings.TrimLeft(trimmed, string(fc)))
			fenceChar = fc
			fenceLen = fl
			continue
		}

		if strings.HasPrefix(trimmed, "#") {
			// CommonMark: ATX headings have 1–6 '#' characters.
			hashes := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
			if hashes > 6 {
				continue
			}
			after := trimmed[hashes:]
			// ATX headings require a space or tab after the # sequence (CommonMark spec).
			if len(after) == 0 || (after[0] != ' ' && after[0] != '\t') {
				continue
			}
			title := strings.TrimSpace(after)
			// Strip optional closing # sequence: "Title ###" → "Title" (CommonMark §4.2).
			// If the entire trimmed content is #s (e.g. "# ###"), the heading is empty.
			if len(title) > 0 && title[len(title)-1] == '#' {
				i := len(title)
				for i > 0 && title[i-1] == '#' {
					i--
				}
				if i == 0 || (title[i-1] == ' ' || title[i-1] == '\t') {
					if i == 0 {
						title = ""
					} else {
						title = strings.TrimRight(title[:i], " \t")
					}
				}
			}
			if title != "" {
				return title
			}
		}
	}
	return ""
}

// extractTitleFromFile reads the first 8KB of the file and extracts the title.
// Returns ("", false) on read error so callers can skip updating stored titles.
func extractTitleFromFile(path string) (string, bool) {
	f, err := os.Open(path) //nolint:gosec
	if err != nil {
		return "", false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, headFileSizeLimit))
	if err != nil {
		return "", false
	}
	return extractTitle(string(data)), true
}

// FileID generates a deterministic file ID from an absolute path.
// The ID is the first 8 characters of the SHA-256 hex digest.
func FileID(absPath string) string {
	h := sha256.Sum256([]byte(absPath))
	return hex.EncodeToString(h[:])[:8]
}

type Group struct {
	Name  string       `json:"name"`
	Files []*FileEntry `json:"files"`
}

type sseEvent struct {
	Name string // SSE event name
	Data string // SSE data payload (JSON)
}

const (
	eventUpdate          = "update"
	eventFileChanged     = "file-changed"
	eventCheckboxChanged = "checkbox-changed"
)

// watchOps is the set of fswatcher ops the watch loop reacts to.
// Chmod is intentionally excluded because the loop ignores it.
const watchOps = fswatcher.Create | fswatcher.Write | fswatcher.Remove | fswatcher.Rename

// GlobPattern represents a glob pattern being watched for new files.
type GlobPattern struct {
	Pattern      string // Absolute glob pattern
	PatternSlash string // Pre-converted to forward slashes for doublestar matching
	BaseDir      string // Base directory extracted via SplitPattern
	Group        string // Target group for matched files
}

// IsRecursive returns true if the pattern contains ** for recursive matching.
func (gp *GlobPattern) IsRecursive() bool {
	return strings.Contains(gp.Pattern, "**")
}

type State struct {
	mu          sync.RWMutex
	groups      map[string]*Group
	subscribers map[chan sseEvent]struct{}
	subMu       sync.RWMutex
	watcher     *fswatcher.Watcher
	restartCh   chan string
	shutdownCh  chan struct{}
	patterns    []*GlobPattern
	watchedDirs map[string]int // directory → reference count
	// pathAliases maps a canonical (symlink-resolved) path back to the
	// original path we stored. The fswatcher watcher canonicalizes paths,
	// so events arrive with the resolved form (e.g. /private/var/...) while
	// our state keeps the user-facing form (/var/...). This mapping lets
	// the watch loop translate event paths back to their stored keys.
	pathAliases map[string]string
	// aliasReverse maps the original path to its canonical form, so an
	// entry can be removed without re-running EvalSymlinks (which would
	// fail once the underlying file or directory is gone).
	aliasReverse map[string]string

	fileChangeDebounce time.Duration
	fileChangeTimers   map[string]*time.Timer

	checkboxSources     map[string]map[string]bool // fileID → checkboxKey → source checked
	checkboxOverrides   map[string]map[string]bool // fileID → checkboxKey → overridden checked
	checkboxOrderedKeys map[string][]string        // fileID → keys in document order

	backupCh     chan struct{}     // dirty signal (buffered, size 1)
	backupSaveFn func(RestoreData) // backup write callback
	backupDone   chan struct{}     // closed when backupLoop exits

	authToken    string              // API auth token; empty disables auth (tests/dev)
	allowedHosts map[string]struct{} // accepted Host header values (anti DNS-rebind); empty skips the check
}

const defaultFileChangeDebounce = 200 * time.Millisecond

func NewState(ctx context.Context) *State {
	w, err := fswatcher.NewWatcher()
	if err != nil {
		slog.Warn("failed to create file watcher", "error", err)
	}

	s := &State{
		groups:              make(map[string]*Group),
		subscribers:         make(map[chan sseEvent]struct{}),
		watcher:             w,
		restartCh:           make(chan string, 1),
		shutdownCh:          make(chan struct{}, 1),
		watchedDirs:         make(map[string]int),
		pathAliases:         make(map[string]string),
		aliasReverse:        make(map[string]string),
		fileChangeDebounce:  defaultFileChangeDebounce,
		fileChangeTimers:    make(map[string]*time.Timer),
		checkboxSources:     make(map[string]map[string]bool),
		checkboxOverrides:   make(map[string]map[string]bool),
		checkboxOrderedKeys: make(map[string][]string),
	}

	if w != nil {
		donegroup.Go(ctx, func() error {
			s.watchLoop()
			return nil
		})
	}

	return s
}

// SetAuth enables API authentication. token is required (via the mo_token cookie
// or X-Mo-Token header) on all /_/ requests; allowedHosts, when non-empty,
// restricts the accepted Host header (defense against DNS-rebinding). Passing an
// empty token leaves authentication disabled.
func (s *State) SetAuth(token string, allowedHosts []string) {
	s.authToken = token
	if len(allowedHosts) > 0 {
		s.allowedHosts = make(map[string]struct{}, len(allowedHosts))
		for _, h := range allowedHosts {
			s.allowedHosts[h] = struct{}{}
		}
	}
}

// ErrBinaryFile is returned when a file is detected as binary.
var ErrBinaryFile = errors.New("binary file is not supported")

// ErrFileNotFound is returned when a file is not found in the specified group.
var ErrFileNotFound = errors.New("file not found")

// readFileHead reads the first 8KB of the file at path.
// Returns the bytes read and any error (os.ErrNotExist is passed through).
// Non-regular files return an error.
func readFileHead(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, fmt.Errorf("not a regular file: %s", path)
	}
	f, err := os.Open(path) //nolint:gosec
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, headFileSizeLimit))
}

func (s *State) AddFile(absPath, groupName string) (*FileEntry, error) {
	// Check for duplicates before doing any I/O.
	s.mu.RLock()
	if g, ok := s.groups[groupName]; ok {
		for _, f := range g.Files {
			if f.Path == absPath {
				s.mu.RUnlock()
				return f, nil
			}
		}
	}
	s.mu.RUnlock()

	fileType := DetectFileType(absPath)
	var title string

	switch fileType {
	case FileTypePDF, FileTypeImage:
		// Binary types: verify regular file, skip content checks.
		fi, err := os.Stat(absPath)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("failed to stat file %s: %w", absPath, err)
			}
		} else if !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("not a regular file: %s", absPath)
		}
	default:
		// Text types: read the head for binary detection and title extraction.
		head, err := readFileHead(absPath)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, fmt.Errorf("failed to read file %s: %w", absPath, err)
			}
		} else if len(head) > 0 && bytes.IndexByte(head, 0) >= 0 {
			if fileType == FileTypeUnknown {
				fileType = FileTypeBinary
			} else {
				return nil, fmt.Errorf("%s: %w", absPath, ErrBinaryFile)
			}
		}
		if fileType != FileTypeBinary {
			title = extractTitle(string(head))
		}
	}

	var checkboxSrc map[string]bool
	var checkboxOrdered []string
	if fileType == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			checkboxSrc, checkboxOrdered = ExtractCheckboxes(string(fullContent))
		}
	}

	var canonical string
	if s.watcher != nil {
		canonical = resolvePathAlias(absPath)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	g, ok := s.groups[groupName]
	if !ok {
		g = &Group{Name: groupName}
		s.groups[groupName] = g
	}

	// Re-check after re-acquiring the lock.
	for _, f := range g.Files {
		if f.Path == absPath {
			return f, nil
		}
	}

	entry := &FileEntry{
		Name:  filepath.Base(absPath),
		ID:    FileID(absPath),
		Path:  absPath,
		Title: title,
		Type:  fileType,
	}
	g.Files = append(g.Files, entry)

	if len(checkboxSrc) > 0 {
		s.checkboxSources[entry.ID] = checkboxSrc
	}
	if len(checkboxOrdered) > 0 {
		s.checkboxOrderedKeys[entry.ID] = checkboxOrdered
	}

	if s.watcher != nil {
		if err := s.watcher.Add(absPath, watchOps); err != nil {
			slog.Warn("failed to watch file", "path", absPath, "error", err)
		} else {
			s.registerPathAlias(absPath, canonical)
		}
	}

	slog.Info("file added", "path", absPath, "group", groupName, "id", entry.ID) //nolint:gosec // G706: structured logging fields, no injection risk

	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return entry, nil
}

func (s *State) AddUploadedFile(name, content, groupName string) *FileEntry {
	s.mu.Lock()
	defer s.mu.Unlock()

	h := sha256.New()
	h.Write([]byte("upload:"))
	h.Write([]byte(content))
	id := "u" + hex.EncodeToString(h.Sum(nil))[:7]

	g, ok := s.groups[groupName]
	if !ok {
		g = &Group{Name: groupName}
		s.groups[groupName] = g
	}

	// Check for a duplicate within the target group only, consistent with AddFile.
	for _, f := range g.Files {
		if f.ID == id {
			return f
		}
	}

	head := content
	if len(head) > headFileSizeLimit {
		head = head[:headFileSizeLimit]
	}
	title := extractTitle(head)

	entry := &FileEntry{
		Name:     name,
		ID:       id,
		Title:    title,
		Uploaded: true,
		Type:     DetectFileType(name),
		content:  content,
	}
	g.Files = append(g.Files, entry)

	if entry.Type == FileTypeMarkdown {
		sources, ordered := ExtractCheckboxes(content)
		if len(sources) > 0 {
			s.checkboxSources[entry.ID] = sources
		}
		if len(ordered) > 0 {
			s.checkboxOrderedKeys[entry.ID] = ordered
		}
	}

	slog.Info("uploaded file added", "name", name, "group", groupName, "id", entry.ID) //nolint:gosec // G706: structured logging fields, no injection risk

	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return entry
}

func (s *State) Groups() []Group {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Deep-copy each Group and its FileEntry pointers while holding the lock
	// so callers (e.g. JSON encoding after the lock is released) never share
	// state with in-place mutations such as notifyFileChangedByPath's Title
	// updates or RemoveFilesByPath's slice compaction.
	result := make([]Group, 0, len(s.groups))
	for _, g := range s.groups {
		var files []*FileEntry
		if g.Files != nil {
			files = make([]*FileEntry, len(g.Files))
			for i, f := range g.Files {
				fc := *f
				files[i] = &fc
			}
		}
		gc := *g
		gc.Files = files
		result = append(result, gc)
	}
	return result
}

func (s *State) FindFile(id, groupName string) *FileEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if g, ok := s.groups[groupName]; ok {
		for _, f := range g.Files {
			if f.ID == id {
				return f
			}
		}
	}
	return nil
}

func (s *State) ReorderFiles(groupName string, fileIDs []string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	g, ok := s.groups[groupName]
	if !ok {
		return false
	}

	if len(fileIDs) != len(g.Files) {
		return false
	}

	idToFile := make(map[string]*FileEntry, len(g.Files))
	for _, f := range g.Files {
		idToFile[f.ID] = f
	}

	reordered := make([]*FileEntry, 0, len(fileIDs))
	for _, id := range fileIDs {
		f, ok := idToFile[id]
		if !ok {
			return false
		}
		reordered = append(reordered, f)
	}

	g.Files = reordered
	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return true
}

func (s *State) MoveFile(id, sourceGroupName, targetGroup string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var file *FileEntry
	var sourceGroup *Group
	if g, ok := s.groups[sourceGroupName]; ok {
		for _, f := range g.Files {
			if f.ID == id {
				file = f
				sourceGroup = g
				break
			}
		}
	}
	if file == nil {
		return ErrFileNotFound
	}

	if sourceGroupName == targetGroup {
		return fmt.Errorf("file is already in group %q", targetGroup)
	}

	// Check for duplicate in target group (by path for filesystem files, by ID for uploaded files)
	if tg, ok := s.groups[targetGroup]; ok {
		for _, f := range tg.Files {
			if file.Uploaded {
				if f.ID == file.ID {
					return fmt.Errorf("file %q already exists in group %q", file.Name, targetGroup)
				}
			} else {
				if f.Path == file.Path {
					return fmt.Errorf("file %q already exists in group %q", file.Name, targetGroup)
				}
			}
		}
	}

	// Remove from source group
	for i, f := range sourceGroup.Files {
		if f.ID == id {
			sourceGroup.Files = append(sourceGroup.Files[:i], sourceGroup.Files[i+1:]...)
			break
		}
	}
	if len(sourceGroup.Files) == 0 && !s.groupHasPatterns(sourceGroupName) {
		delete(s.groups, sourceGroupName)
	}

	// Add to target group
	tg, ok := s.groups[targetGroup]
	if !ok {
		tg = &Group{Name: targetGroup}
		s.groups[targetGroup] = tg
	}
	tg.Files = append(tg.Files, file)

	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return nil
}

// RemoveFilesByPath removes every file entry whose path matches absPath across
// all groups, cleans up the watcher and checkbox state, and drops any groups
// left empty without patterns. Returns true if at least one entry was removed.
func (s *State) RemoveFilesByPath(absPath string) bool {
	if absPath == "" {
		return false
	}

	s.mu.Lock()
	removed := false
	removedIDs := make(map[string]struct{})
	for name, g := range s.groups {
		filtered := g.Files[:0]
		for _, f := range g.Files {
			if f.Path == absPath {
				removed = true
				removedIDs[f.ID] = struct{}{}
				slog.Info("file removed", "path", f.Path, "id", f.ID, "group", name) //nolint:gosec // G706: structured logging fields, no injection risk
				continue
			}
			filtered = append(filtered, f)
		}
		// Clear the truncated tail so removed *FileEntry pointers don't linger
		// in the backing array and block GC.
		for i := len(filtered); i < len(g.Files); i++ {
			g.Files[i] = nil
		}
		g.Files = filtered
		if len(g.Files) == 0 && !s.groupHasPatterns(name) {
			delete(s.groups, name)
		}
	}
	for id := range removedIDs {
		if !s.fileIDReferencedLocked(id) {
			delete(s.checkboxSources, id)
			delete(s.checkboxOverrides, id)
			delete(s.checkboxOrderedKeys, id)
		}
	}
	if removed && s.watcher != nil {
		if err := s.watcher.Remove(absPath); err != nil {
			slog.Warn("failed to unwatch file", "path", absPath, "error", err)
		}
		s.unregisterPathAlias(absPath)
	}
	s.mu.Unlock()

	if removed {
		s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	}
	return removed
}

func (s *State) RemoveFile(id, groupName string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	var removedPath string
	found := false
	if g, ok := s.groups[groupName]; ok {
		for i, f := range g.Files {
			if f.ID == id {
				removedPath = f.Path
				g.Files = append(g.Files[:i], g.Files[i+1:]...)
				if len(g.Files) == 0 && !s.groupHasPatterns(groupName) {
					delete(s.groups, groupName)
				}
				found = true
				break
			}
		}
	}
	if !found {
		return false
	}

	slog.Info("file removed", "path", removedPath, "id", id, "group", groupName) //nolint:gosec // G706: values are from internal state, not direct user input

	if !s.fileIDReferencedLocked(id) {
		delete(s.checkboxSources, id)
		delete(s.checkboxOverrides, id)
		delete(s.checkboxOrderedKeys, id)
	}

	// Remove watcher only if no other file references the same path.
	if s.watcher != nil && removedPath != "" {
		stillReferenced := false
		for _, g := range s.groups {
			for _, f := range g.Files {
				if f.Path == removedPath {
					stillReferenced = true
					break
				}
			}
			if stillReferenced {
				break
			}
		}
		if !stillReferenced {
			if err := s.watcher.Remove(removedPath); err != nil {
				slog.Warn("failed to unwatch file", "path", removedPath, "error", err)
			}
			s.unregisterPathAlias(removedPath)
		}
	}

	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	return true
}

// RestoreCheckboxOverrides loads persisted checkbox overrides into the state.
// Should be called after all files have been added (so checkboxSources are populated).
func (s *State) RestoreCheckboxOverrides(overrides map[string]map[string]bool) {
	if len(overrides) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	for fileID, ovr := range overrides {
		src := s.checkboxSources[fileID]
		if src == nil {
			continue // File not loaded — skip stale overrides.
		}
		reconciled := make(map[string]bool)
		for key, val := range ovr {
			srcVal, inSrc := src[key]
			if !inSrc || val == srcVal {
				continue // Stale or matches source.
			}
			reconciled[key] = val
		}
		if len(reconciled) > 0 {
			s.checkboxOverrides[fileID] = reconciled
		}
	}
}

func (s *State) Subscribe() chan sseEvent {
	s.subMu.Lock()
	defer s.subMu.Unlock()

	ch := make(chan sseEvent, 16)
	s.subscribers[ch] = struct{}{}
	return ch
}

func (s *State) Unsubscribe(ch chan sseEvent) {
	s.subMu.Lock()
	defer s.subMu.Unlock()

	if _, ok := s.subscribers[ch]; ok {
		delete(s.subscribers, ch)
		close(ch)
	}
}

// CloseAllSubscribers closes all SSE subscriber channels so that
// SSE handlers return and in-flight requests complete before Shutdown.
func (s *State) CloseAllSubscribers() {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.subMu.Lock()
	for ch := range s.subscribers {
		close(ch)
		delete(s.subscribers, ch)
	}
	s.subMu.Unlock()

	if s.watcher != nil {
		s.watcher.Close()
	}
	for path, timer := range s.fileChangeTimers {
		timer.Stop()
		delete(s.fileChangeTimers, path)
	}
}

// RestartCh returns a channel that receives the restore file path when a restart is requested.
func (s *State) RestartCh() <-chan string {
	return s.restartCh
}

// ShutdownCh returns a channel that signals when a shutdown is requested via API.
func (s *State) ShutdownCh() <-chan struct{} {
	return s.shutdownCh
}

// AddPattern registers a glob pattern for automatic file discovery.
// It performs an initial expansion to add existing matches and starts
// watching the base directory for new files.
func (s *State) AddPattern(absPattern, groupName string) ([]*FileEntry, error) {
	// Use forward slashes for doublestar
	dsPattern := filepath.ToSlash(absPattern)
	base, relPat := doublestar.SplitPattern(dsPattern)
	base = filepath.FromSlash(base)

	info, err := os.Stat(base)
	if err != nil {
		return nil, fmt.Errorf("base directory %q does not exist: %w", base, err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("base path %q is not a directory", base)
	}

	gp, added := func() (*GlobPattern, bool) {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, p := range s.patterns {
			if p.Pattern == absPattern && p.Group == groupName {
				return nil, false
			}
		}
		gp := &GlobPattern{
			Pattern:      absPattern,
			PatternSlash: dsPattern,
			BaseDir:      base,
			Group:        groupName,
		}
		s.patterns = append(s.patterns, gp)
		// Ensure the group exists even if no files match yet.
		if _, ok := s.groups[groupName]; !ok {
			s.groups[groupName] = &Group{Name: groupName}
		}
		return gp, true
	}()
	if !added {
		return nil, nil
	}

	// Initial expansion
	matches, err := doublestar.Glob(os.DirFS(base), relPat, doublestar.WithFilesOnly())
	if err != nil {
		return nil, fmt.Errorf("glob expansion failed: %w", err)
	}
	collate.New(language.Und, collate.Numeric).SortStrings(matches)

	var entries []*FileEntry
	for _, m := range matches {
		abs := filepath.Join(base, m)
		entry, err := s.AddFile(abs, groupName)
		if err != nil {
			slog.Warn("skipping file", "path", abs, "error", err)
			continue
		}
		entries = append(entries, entry)
	}

	s.watchDirsForPattern(gp)

	return entries, nil
}

// Patterns returns a copy of all registered glob patterns.
func (s *State) Patterns() []*GlobPattern {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*GlobPattern, len(s.patterns))
	copy(result, s.patterns)
	return result
}

// PatternsForGroup returns the pattern strings for a specific group.
func (s *State) PatternsForGroup(groupName string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []string
	for _, p := range s.patterns {
		if p.Group == groupName {
			result = append(result, p.Pattern)
		}
	}
	return result
}

// RemovePattern removes a glob pattern from the watch list.
// Returns true if the pattern was found and removed.
func (s *State) RemovePattern(absPattern, groupName string) bool {
	var removed *GlobPattern
	func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		for i, p := range s.patterns {
			if p.Pattern == absPattern && p.Group == groupName {
				removed = p
				s.patterns = append(s.patterns[:i], s.patterns[i+1:]...)
				break
			}
		}
	}()

	if removed == nil {
		return false
	}

	s.walkDirsForPattern(removed, s.removeDirWatch)

	slog.Info("pattern removed", "pattern", absPattern, "group", groupName)
	s.mu.Lock()
	// Clean up empty group when last pattern is removed and no files remain.
	if g, ok := s.groups[groupName]; ok && len(g.Files) == 0 && !s.groupHasPatterns(groupName) {
		delete(s.groups, groupName)
	}
	s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	s.mu.Unlock()
	return true
}

// UploadedFileData represents an uploaded file's content for persistence.
type UploadedFileData struct {
	Name    string `json:"name"`
	Content string `json:"content"`
	Group   string `json:"group"`
}

// RestoreData represents the state to be persisted across restarts.
type RestoreData struct {
	Groups            map[string][]string        `json:"groups"`
	Patterns          map[string][]string        `json:"patterns,omitempty"`
	UploadedFiles     []UploadedFileData         `json:"uploadedFiles,omitempty"`
	CheckboxOverrides map[string]map[string]bool `json:"checkboxOverrides,omitempty"`
}

// WriteRestoreFile writes RestoreData to a temporary file and returns the path.
func WriteRestoreFile(data RestoreData) (string, error) {
	f, err := os.CreateTemp("", "mo-restore-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	defer f.Close()

	if err := json.NewEncoder(f).Encode(data); err != nil {
		os.Remove(f.Name()) //nolint:gosec // Path is from our own CreateTemp, not user-supplied
		return "", fmt.Errorf("failed to write restore data: %w", err)
	}

	return f.Name(), nil
}

// ExportState writes the current groups, file paths, and patterns to a temporary file and returns the path.
func (s *State) ExportState() (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return WriteRestoreFile(s.snapshotRestoreData())
}

// EnableBackup starts a background goroutine that periodically saves state
// via the provided callback when state changes are detected.
func (s *State) EnableBackup(ctx context.Context, saveFn func(RestoreData)) {
	s.backupCh = make(chan struct{}, 1)
	s.backupSaveFn = saveFn
	s.backupDone = make(chan struct{})
	donegroup.Go(ctx, func() error {
		defer close(s.backupDone)
		s.backupLoop(ctx)
		return nil
	})
	// Persist state that may have been populated before backup was enabled.
	s.markDirty()
}

// CheckboxState returns the sources, overrides, and ordered keys for a file.
func (s *State) CheckboxState(id string) (sources, overrides map[string]bool, orderedKeys []string, found bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Verify file exists.
	fileFound := false
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				fileFound = true
				break
			}
		}
		if fileFound {
			break
		}
	}
	if !fileFound {
		return nil, nil, nil, false
	}

	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	ordered := s.checkboxOrderedKeys[id]
	if len(ordered) == 0 {
		ordered = []string{}
	}
	return src, ovr, ordered, true
}

// SetCheckbox sets or removes a checkbox override for a file.
func (s *State) SetCheckbox(id, key string, checked bool) bool {
	s.mu.Lock()

	fileFound := false
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				fileFound = true
				break
			}
		}
		if fileFound {
			break
		}
	}
	if !fileFound {
		s.mu.Unlock()
		return false
	}

	sourceVal := false
	if src, ok := s.checkboxSources[id]; ok {
		sourceVal = src[key]
	}

	if checked == sourceVal {
		// Matches source — remove override.
		if ovr, ok := s.checkboxOverrides[id]; ok {
			delete(ovr, key)
			if len(ovr) == 0 {
				delete(s.checkboxOverrides, id)
			}
		}
	} else {
		if s.checkboxOverrides[id] == nil {
			s.checkboxOverrides[id] = make(map[string]bool)
		}
		s.checkboxOverrides[id][key] = checked
	}

	src := s.checkboxSources[id]
	if src == nil {
		src = map[string]bool{}
	}
	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	ordered := s.checkboxOrderedKeys[id]
	if len(ordered) == 0 {
		ordered = []string{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, src, ovr, ordered)
	return true
}

// UncheckAll sets all checkboxes to unchecked for a file.
func (s *State) UncheckAll(id string) bool {
	s.mu.Lock()

	fileFound := false
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				fileFound = true
				break
			}
		}
		if fileFound {
			break
		}
	}
	if !fileFound {
		s.mu.Unlock()
		return false
	}

	src := s.checkboxSources[id]
	if len(src) == 0 {
		s.mu.Unlock()
		return true
	}

	newOverrides := make(map[string]bool)
	for key, sourceChecked := range src {
		if sourceChecked {
			newOverrides[key] = false
		}
	}

	// Remove any existing overrides for source-false keys.
	if len(newOverrides) > 0 {
		s.checkboxOverrides[id] = newOverrides
	} else {
		delete(s.checkboxOverrides, id)
	}

	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	srcCopy := make(map[string]bool, len(src))
	maps.Copy(srcCopy, src)
	ordered := s.checkboxOrderedKeys[id]
	if len(ordered) == 0 {
		ordered = []string{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, srcCopy, ovr, ordered)
	return true
}

// CheckAll sets all checkboxes to checked for a file.
func (s *State) CheckAll(id string) bool {
	s.mu.Lock()

	fileFound := false
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				fileFound = true
				break
			}
		}
		if fileFound {
			break
		}
	}
	if !fileFound {
		s.mu.Unlock()
		return false
	}

	src := s.checkboxSources[id]
	if len(src) == 0 {
		s.mu.Unlock()
		return true
	}

	newOverrides := make(map[string]bool)
	for key, sourceChecked := range src {
		if !sourceChecked {
			newOverrides[key] = true
		}
	}

	if len(newOverrides) > 0 {
		s.checkboxOverrides[id] = newOverrides
	} else {
		delete(s.checkboxOverrides, id)
	}

	ovr := s.checkboxOverrides[id]
	if ovr == nil {
		ovr = map[string]bool{}
	}
	srcCopy := make(map[string]bool, len(src))
	maps.Copy(srcCopy, src)
	ordered := s.checkboxOrderedKeys[id]
	if len(ordered) == 0 {
		ordered = []string{}
	}
	s.mu.Unlock()

	s.broadcastCheckboxChanged(id, srcCopy, ovr, ordered)
	return true
}

// fileIDReferencedLocked reports whether any group still references id.
// Caller must hold s.mu.
func (s *State) fileIDReferencedLocked(id string) bool {
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.ID == id {
				return true
			}
		}
	}
	return false
}

// snapshotRestoreData creates a RestoreData snapshot of the current state.
// Caller must hold s.mu (at least RLock).
func (s *State) snapshotRestoreData() RestoreData {
	data := RestoreData{
		Groups: make(map[string][]string, len(s.groups)),
	}
	for name, g := range s.groups {
		paths := make([]string, 0, len(g.Files))
		for _, f := range g.Files {
			if f.Uploaded {
				data.UploadedFiles = append(data.UploadedFiles, UploadedFileData{
					Name:    f.Name,
					Content: f.content,
					Group:   name,
				})
				continue
			}
			paths = append(paths, f.Path)
		}
		data.Groups[name] = paths
	}

	if len(s.patterns) > 0 {
		data.Patterns = make(map[string][]string)
		for _, p := range s.patterns {
			data.Patterns[p.Group] = append(data.Patterns[p.Group], p.Pattern)
		}
	}

	if len(s.checkboxOverrides) > 0 {
		data.CheckboxOverrides = make(map[string]map[string]bool, len(s.checkboxOverrides))
		for fileID, overrides := range s.checkboxOverrides {
			if len(overrides) > 0 {
				cp := make(map[string]bool, len(overrides))
				maps.Copy(cp, overrides)
				data.CheckboxOverrides[fileID] = cp
			}
		}
	}

	return data
}

// markDirty signals that state has changed and a backup save is needed.
// Non-blocking: safe to call while holding s.mu.
func (s *State) markDirty() {
	if s.backupCh == nil {
		return
	}
	select {
	case s.backupCh <- struct{}{}:
	default:
	}
}

func (s *State) backupLoop(ctx context.Context) {
	const debounce = 1 * time.Second
	timer := time.NewTimer(debounce)
	timer.Stop()
	for {
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			s.saveBackup()
			return
		case _, ok := <-s.backupCh:
			if !ok {
				return
			}
			timer.Reset(debounce)
		case <-timer.C:
			s.saveBackup()
		}
	}
}

func (s *State) saveBackup() {
	if s.backupSaveFn == nil {
		return
	}
	s.mu.RLock()
	data := s.snapshotRestoreData()
	s.mu.RUnlock()
	s.backupSaveFn(data)
}

// groupHasPatterns reports whether the group has any registered watch patterns.
// Caller must hold s.mu.
func (s *State) groupHasPatterns(groupName string) bool {
	for _, p := range s.patterns {
		if p.Group == groupName {
			return true
		}
	}
	return false
}

func (s *State) walkDirsForPattern(gp *GlobPattern, fn func(string)) {
	if s.watcher == nil {
		return
	}
	if !gp.IsRecursive() {
		fn(gp.BaseDir)
		return
	}

	if err := filepath.WalkDir(gp.BaseDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			// Best-effort: still process this path so unwatch can decrement refcounts.
			fn(path)
			return fs.SkipDir
		}
		if d.IsDir() {
			fn(path)
		}
		return nil
	}); err != nil {
		// BaseDir may have been deleted; still clean up the base directory entry.
		fn(gp.BaseDir)
		slog.Warn("failed to walk directories for pattern", "pattern", gp.Pattern, "base", gp.BaseDir, "error", err)
	}
}

func (s *State) removeDirWatch(dir string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if count, ok := s.watchedDirs[dir]; ok {
		count--
		if count <= 0 {
			delete(s.watchedDirs, dir)
			if s.watcher != nil {
				if err := s.watcher.Remove(dir); err != nil {
					slog.Warn("failed to remove directory watch", "dir", dir, "error", err)
				}
			}
			s.unregisterPathAlias(dir)
		} else {
			s.watchedDirs[dir] = count
		}
	}
}

func (s *State) watchLoop() {
	for {
		select {
		case event, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			eventPath := s.translateEventPath(event.Name)
			// State entries may be stored under either the original or the
			// canonical form (e.g. when the user mixes /var/... and
			// /private/var/... explicitly), so look up refs for both paths
			// when they differ. Track each set separately so file-change
			// scheduling only runs for the form(s) that actually matched,
			// while delete handling still operates on the union.
			refsTranslated := s.findRefsByPath(eventPath)
			var refsRaw []fileRef
			if eventPath != event.Name {
				refsRaw = s.findRefsByPath(event.Name)
			}
			if len(refsTranslated)+len(refsRaw) > 0 {
				if event.Op.Has(fswatcher.Write) || event.Op.Has(fswatcher.Create) {
					slog.Info("file changed", "path", eventPath)
					if len(refsTranslated) > 0 {
						s.scheduleFileChanged(eventPath)
					}
					if len(refsRaw) > 0 {
						s.scheduleFileChanged(event.Name)
					}
				}
				// Editors using atomic save (write-to-temp + rename) cause
				// the original inode to disappear, which removes the watch on
				// some backends. Stat the path to decide whether the file is
				// actually gone, then re-add the watch if it still exists.
				// FSEvents on macOS coalesces historical flags, so a plain
				// Write after a previous atomic save arrives as Write|Rename;
				// trusting Add's error to mean "file gone" wrongly drops the
				// entry (ErrAlreadyAdded for a still-live watch).
				if event.Op.Has(fswatcher.Remove) || event.Op.Has(fswatcher.Rename) {
					time.AfterFunc(100*time.Millisecond, func() {
						if _, statErr := os.Stat(eventPath); errors.Is(statErr, os.ErrNotExist) {
							slog.Info("file deleted, removing from list", "path", eventPath)
							for _, ref := range refsTranslated {
								s.RemoveFile(ref.ID, ref.Group)
							}
							for _, ref := range refsRaw {
								s.RemoveFile(ref.ID, ref.Group)
							}
							return
						}
						if err := s.watcher.Add(eventPath, watchOps); err != nil && !errors.Is(err, fswatcher.ErrAlreadyAdded) {
							slog.Warn("failed to re-watch file", "path", eventPath, "error", err)
							return
						}
						slog.Info("re-watching file", "path", eventPath)
						if len(refsTranslated) > 0 {
							s.scheduleFileChanged(eventPath)
						}
						if len(refsRaw) > 0 {
							s.scheduleFileChanged(event.Name)
						}
					})
				}
			}
			if event.Op.Has(fswatcher.Rename) || event.Op.Has(fswatcher.Remove) {
				if s.isWatchedDir(eventPath) {
					s.handleDirMove(eventPath)
				} else if eventPath != event.Name && s.isWatchedDir(event.Name) {
					s.handleDirMove(event.Name)
				}
			}
			if event.Op.Has(fswatcher.Create) {
				s.handleCreateForGlobs(eventPath)
			}
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			slog.Warn("file watcher error", "error", err)
		}
	}
}

func (s *State) scheduleFileChanged(absPath string) {
	if s.fileChangeDebounce <= 0 {
		s.notifyFileChangedByPath(absPath)
		return
	}

	s.mu.Lock()
	if timer, ok := s.fileChangeTimers[absPath]; ok {
		timer.Stop()
	}
	debounce := s.fileChangeDebounce
	var timer *time.Timer
	timer = time.AfterFunc(debounce, func() {
		s.mu.Lock()
		current, ok := s.fileChangeTimers[absPath]
		if ok && current == timer {
			delete(s.fileChangeTimers, absPath)
		}
		s.mu.Unlock()
		if ok && current == timer {
			s.notifyFileChangedByPath(absPath)
		}
	})
	s.fileChangeTimers[absPath] = timer
	s.mu.Unlock()
}

func (s *State) notifyFileChangedByPath(absPath string) {
	fileType := DetectFileType(absPath)

	// Extract the title outside the lock (file I/O should not hold the mutex).
	var newTitle string
	var titleOK bool
	if fileType != FileTypePDF && fileType != FileTypeImage && fileType != FileTypeBinary {
		newTitle, titleOK = extractTitleFromFile(absPath)
	}

	// Re-extract checkbox sources for reconciliation.
	var newCheckboxSrc map[string]bool
	var newCheckboxOrdered []string
	if fileType == FileTypeMarkdown {
		if fullContent, readErr := os.ReadFile(absPath); readErr == nil {
			newCheckboxSrc, newCheckboxOrdered = ExtractCheckboxes(string(fullContent))
		}
	}

	// Single lock pass: collect IDs, update titles, and reconcile checkboxes.
	var ids []string
	titleChanged := false
	var checkboxChangedIDs []string
	s.mu.Lock()
	for _, g := range s.groups {
		for _, entry := range g.Files {
			if entry.Path != absPath {
				continue
			}
			ids = append(ids, entry.ID)
			if titleOK && entry.Title != newTitle {
				entry.Title = newTitle
				titleChanged = true
			}

			if newCheckboxSrc != nil {
				if len(newCheckboxSrc) > 0 {
					s.checkboxSources[entry.ID] = newCheckboxSrc
				} else {
					delete(s.checkboxSources, entry.ID)
				}
				if len(newCheckboxOrdered) > 0 {
					s.checkboxOrderedKeys[entry.ID] = newCheckboxOrdered
				} else {
					delete(s.checkboxOrderedKeys, entry.ID)
				}

				if overrides, ok := s.checkboxOverrides[entry.ID]; ok {
					for key, value := range overrides {
						sourceValue, inSource := newCheckboxSrc[key]
						if !inSource || value == sourceValue {
							delete(overrides, key)
						}
					}
					if len(overrides) == 0 {
						delete(s.checkboxOverrides, entry.ID)
					}
				}

				// Always broadcast so the frontend's sources stay in sync.
				checkboxChangedIDs = append(checkboxChangedIDs, entry.ID)
			}
		}
	}
	s.mu.Unlock()

	if len(ids) == 0 {
		return
	}
	if titleChanged {
		s.sendEvent(sseEvent{Name: eventUpdate, Data: "{}"})
	}
	s.notifyFileChanged(ids)

	for _, id := range checkboxChangedIDs {
		sources, overrides, orderedKeys, _ := s.CheckboxState(id)
		s.broadcastCheckboxChanged(id, sources, overrides, orderedKeys)
	}
}

func (s *State) notifyFileChanged(ids []string) {
	for _, id := range ids {
		b, err := json.Marshal(struct {
			ID string `json:"id"`
		}{ID: id})
		if err != nil {
			slog.Error("notifyFileChanged", "err", err)
			continue
		}
		s.sendEvent(sseEvent{
			Name: eventFileChanged,
			Data: string(b),
		})
	}
}

type fileRef struct {
	ID    string
	Group string
}

// resolvePathAlias returns the canonical (symlink-resolved) form of orig
// when it differs from orig, or "" otherwise. Performs filesystem I/O, so
// callers should invoke it outside any critical section.
func resolvePathAlias(orig string) string {
	canonical, err := filepath.EvalSymlinks(orig)
	if err != nil || canonical == orig {
		return ""
	}
	return canonical
}

// registerPathAlias records canonical → orig (and the reverse) so watcher
// events can be mapped back to the stored path. canonical must be the
// pre-resolved value returned by resolvePathAlias. Caller must hold s.mu
// for write.
func (s *State) registerPathAlias(orig, canonical string) {
	if canonical == "" {
		return
	}
	s.pathAliases[canonical] = orig
	s.aliasReverse[orig] = canonical
}

// unregisterPathAlias removes any alias previously registered for orig.
// Caller must hold s.mu for write.
func (s *State) unregisterPathAlias(orig string) {
	canonical, ok := s.aliasReverse[orig]
	if !ok {
		return
	}
	delete(s.pathAliases, canonical)
	delete(s.aliasReverse, orig)
}

// translateEventPath returns the stored form of an event path when the
// watcher reported a canonicalized variant; otherwise it returns p as-is.
func (s *State) translateEventPath(p string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if orig, ok := s.pathAliases[p]; ok {
		return orig
	}
	// Files created inside a watched (symlinked) directory arrive with the
	// canonical path of that directory as a prefix, but only the directory
	// itself has an alias entry. Walk up parents to find the closest alias
	// and rebuild the path with the original prefix.
	dir := p
	for {
		parent := filepath.Dir(dir)
		if parent == dir {
			return p
		}
		dir = parent
		if orig, ok := s.pathAliases[dir]; ok {
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return p
			}
			return filepath.Join(orig, rel)
		}
	}
}

func (s *State) findRefsByPath(absPath string) []fileRef {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var refs []fileRef
	for _, g := range s.groups {
		for _, f := range g.Files {
			if f.Path == absPath {
				refs = append(refs, fileRef{ID: f.ID, Group: g.Name})
			}
		}
	}
	return refs
}

func (s *State) findRefsByPathPrefix(dirPath string) []fileRef {
	prefix := dirPath + string(filepath.Separator)
	s.mu.RLock()
	defer s.mu.RUnlock()

	var refs []fileRef
	for _, g := range s.groups {
		for _, f := range g.Files {
			if strings.HasPrefix(f.Path, prefix) {
				refs = append(refs, fileRef{ID: f.ID, Group: g.Name})
			}
		}
	}
	return refs
}

func (s *State) isWatchedDir(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.watchedDirs[path]
	return ok
}

func (s *State) handleDirMove(dirPath string) {
	refs := s.findRefsByPathPrefix(dirPath)
	for _, ref := range refs {
		slog.Info("removing stale file after directory move", "dir", dirPath, "id", ref.ID)
		s.RemoveFile(ref.ID, ref.Group)
	}
}

func (s *State) sendEvent(e sseEvent) {
	s.subMu.RLock()
	defer s.subMu.RUnlock()

	for ch := range s.subscribers {
		select {
		case ch <- e:
		default:
			slog.Warn("SSE event dropped (subscriber buffer full)", "event", e.Name)
		}
	}
	if e.Name == eventUpdate {
		s.markDirty()
	}
}

func (s *State) watchDirsForPattern(gp *GlobPattern) {
	s.walkDirsForPattern(gp, s.addDirWatch)
}

func (s *State) addDirWatch(dir string) {
	s.mu.Lock()
	s.watchedDirs[dir]++
	added := false
	if s.watchedDirs[dir] == 1 && s.watcher != nil {
		if err := s.watcher.Add(dir, watchOps); err != nil {
			delete(s.watchedDirs, dir)
			slog.Warn("failed to watch directory", "path", dir, "error", err)
		} else {
			added = true
		}
	}
	s.mu.Unlock()

	if !added {
		return
	}

	canonical := resolvePathAlias(dir)

	s.mu.Lock()
	defer s.mu.Unlock()
	// Register the alias only if the directory is still being watched: a
	// concurrent removeDirWatch may have dropped it during the unlock window.
	if _, stillWatched := s.watchedDirs[dir]; stillWatched {
		s.registerPathAlias(dir, canonical)
	}
}

func (s *State) handleCreateForGlobs(path string) {
	s.mu.RLock()
	if len(s.patterns) == 0 {
		s.mu.RUnlock()
		return
	}
	patterns := make([]*GlobPattern, len(s.patterns))
	copy(patterns, s.patterns)
	s.mu.RUnlock()

	info, err := os.Stat(path)
	if err != nil {
		return
	}

	if info.IsDir() {
		watched := false
		for _, gp := range patterns {
			if !gp.IsRecursive() {
				continue
			}
			if !strings.HasPrefix(path, gp.BaseDir) {
				continue
			}
			if !watched {
				s.addDirWatch(path)
				// Scan directory contents for matching files
				filepath.WalkDir(path, func(p string, d os.DirEntry, err error) error { //nolint:errcheck
					if err != nil || d.IsDir() {
						return nil
					}
					s.matchAndAddFile(p, patterns)
					return nil
				})
				watched = true
			}
		}
		return
	}

	s.matchAndAddFile(path, patterns)
}

func (s *State) matchAndAddFile(path string, patterns []*GlobPattern) {
	dsPath := filepath.ToSlash(path)
	for _, gp := range patterns {
		matched, err := doublestar.Match(gp.PatternSlash, dsPath)
		if err != nil {
			continue
		}
		if matched {
			if _, err := s.AddFile(path, gp.Group); err != nil {
				slog.Warn("skipping file", "path", path, "error", err)
				return
			}
			slog.Info("auto-added file via glob", "path", path, "pattern", gp.Pattern, "group", gp.Group)
			return
		}
	}
}

type reorderFilesRequest struct {
	FileIDs []string `json:"fileIds"`
}

type moveFileRequest struct {
	Group string `json:"group"`
}

type addFileRequest struct {
	Path string `json:"path"`
}

type uploadFileRequest struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type patternRequest struct {
	Pattern string `json:"pattern"`
	Group   string `json:"group"`
}

// AddPatternResponse is the JSON response for the add-pattern endpoint.
type AddPatternResponse struct {
	Matched int          `json:"matched"`
	Files   []*FileEntry `json:"files,omitempty"`
}

type fileContentResponse struct {
	Content string `json:"content"`
	BaseDir string `json:"baseDir"`
}

type searchAnchor struct {
	Kind  string `json:"kind"`
	Value string `json:"value"`
}

type searchMatch struct {
	Line    int          `json:"line"`
	Column  int          `json:"column,omitempty"`
	Text    string       `json:"text"`
	Before  []string     `json:"before,omitempty"`
	After   []string     `json:"after,omitempty"`
	Heading string       `json:"heading,omitempty"`
	Anchor  searchAnchor `json:"anchor"`
}

type searchResult struct {
	FileID   string        `json:"fileId"`
	FileName string        `json:"fileName"`
	Title    string        `json:"title,omitempty"`
	Path     string        `json:"path"`
	Uploaded bool          `json:"uploaded"`
	Matches  []searchMatch `json:"matches"`
}

type searchResponse struct {
	Query   string         `json:"query"`
	Group   string         `json:"group"`
	Limit   int            `json:"limit"`
	Context int            `json:"context"`
	Total   int            `json:"total"`
	Results []searchResult `json:"results"`
}

type openFileRequest struct {
	FileID string `json:"fileId"`
	Path   string `json:"path"`
}

// resolveGroupFromPath extracts and validates the group name from the URL path.
func resolveGroupFromPath(r *http.Request) (string, error) {
	return ResolveGroupName(r.PathValue("group"))
}

func NewHandler(state *State) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /_/api/groups/{group}/files", handleAddFile(state))
	mux.HandleFunc("POST /_/api/groups/{group}/files/upload", handleUploadFile(state))
	mux.HandleFunc("DELETE /_/api/groups/{group}/files/{id}", handleRemoveFile(state))
	mux.HandleFunc("PUT /_/api/groups/{group}/files/{id}/group", handleMoveFile(state))
	mux.HandleFunc("GET /_/api/groups", handleGroups(state))
	mux.HandleFunc("PUT /_/api/groups/{group}/reorder", handleReorderFiles(state))
	mux.HandleFunc("GET /_/api/groups/{group}/files/{id}/content", handleFileContent(state))
	mux.HandleFunc("GET /_/api/groups/{group}/files/{id}/checkboxes", handleGetCheckboxes(state))
	mux.HandleFunc("PUT /_/api/groups/{group}/files/{id}/checkboxes/{key}", handlePutCheckbox(state))
	mux.HandleFunc("DELETE /_/api/groups/{group}/files/{id}/checkboxes", handleDeleteCheckboxes(state))
	mux.HandleFunc("POST /_/api/groups/{group}/files/{id}/checkboxes/check-all", handleCheckAll(state))
	mux.HandleFunc("GET /_/api/search", handleSearch(state))
	mux.HandleFunc("GET /_/api/groups/{group}/files/{id}/raw", handleFileServe(state))
	mux.HandleFunc("GET /_/api/groups/{group}/files/{id}/raw/{path...}", handleFileRaw(state))
	mux.HandleFunc("POST /_/api/groups/{group}/files/open", handleOpenFile(state))
	mux.HandleFunc("POST /_/api/patterns", handleAddPattern(state))
	mux.HandleFunc("DELETE /_/api/patterns", handleRemovePattern(state))
	mux.HandleFunc("POST /_/api/restart", handleRestart(state))
	mux.HandleFunc("POST /_/api/shutdown", handleShutdown(state))
	mux.HandleFunc("GET /_/api/status", handleStatus(state))
	mux.HandleFunc("GET /_/api/version", handleVersion())
	mux.HandleFunc("GET /_/events", handleSSE(state))
	mux.HandleFunc("GET /", handleSPA())

	return withAuth(state, withCSP(mux))
}

const (
	authCookieName = "mo_token"
	authHeaderName = "X-Mo-Token" //nolint:gosec // header name, not a credential
)

// withAuth gates the /_/ API surface behind the per-server token and (when
// configured) a Host allowlist. The token is accepted via the X-Mo-Token header
// (used by the CLI) or the mo_token cookie (issued to the same-origin SPA). A
// SameSite=Strict cookie is never sent on cross-site requests and cannot be read
// cross-origin, so a malicious web page cannot forge authenticated calls even
// though the server binds to localhost. When no token is configured (tests/dev),
// the middleware is a no-op.
func withAuth(state *State, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if state.authToken == "" {
			next.ServeHTTP(w, r)
			return
		}

		if len(state.allowedHosts) > 0 {
			if _, ok := state.allowedHosts[r.Host]; !ok {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}

		if strings.HasPrefix(r.URL.Path, "/_/") {
			if !validToken(r, state.authToken) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		http.SetCookie(w, &http.Cookie{
			Name:     authCookieName,
			Value:    state.authToken,
			Path:     "/",
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		next.ServeHTTP(w, r)
	})
}

// validToken reports whether the request carries the expected token via the
// X-Mo-Token header or the mo_token cookie, using a constant-time comparison.
func validToken(r *http.Request, want string) bool {
	if h := r.Header.Get(authHeaderName); h != "" &&
		subtle.ConstantTimeCompare([]byte(h), []byte(want)) == 1 {
		return true
	}
	if c, err := r.Cookie(authCookieName); err == nil &&
		subtle.ConstantTimeCompare([]byte(c.Value), []byte(want)) == 1 {
		return true
	}
	return false
}

func withCSP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' https: data:; "+
				"font-src 'self' data:; "+
				"connect-src 'self'; "+
				"worker-src 'self' blob:; "+
				"object-src 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'; "+
				"frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func handleAddFile(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var req addFileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		absPath, err := filepath.Abs(req.Path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if _, err := os.Stat(absPath); err != nil {
			http.Error(w, fmt.Sprintf("file not found: %s", absPath), http.StatusBadRequest)
			return
		}

		entry, err := state.AddFile(absPath, group)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(entry); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleUploadFile(state *State) http.HandlerFunc {
	const maxRequestSize = 12 << 20 // 12MB (headroom for JSON envelope)
	const maxContentSize = 10 << 20 // 10MB
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxRequestSize)
		var req uploadFileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			if maxBytesErr, ok := errors.AsType[*http.MaxBytesError](err); ok && maxBytesErr != nil {
				http.Error(w, "file too large (max 10MB)", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if len(req.Content) > maxContentSize {
			http.Error(w, "file too large (max 10MB)", http.StatusRequestEntityTooLarge)
			return
		}

		if req.Name == "" {
			http.Error(w, "missing file name", http.StatusBadRequest)
			return
		}

		entry := state.AddUploadedFile(req.Name, req.Content, group)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(entry); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleRemoveFile(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
		if !state.RemoveFile(id, group) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleMoveFile(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sourceGroup, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}
		var req moveFileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		targetGroup, err := ResolveGroupName(req.Group)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := state.MoveFile(id, sourceGroup, targetGroup); err != nil {
			if errors.Is(err, ErrFileNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusConflict)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleReorderFiles(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var req reorderFilesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if !state.ReorderFiles(group, req.FileIDs) {
			http.Error(w, "invalid file IDs or group not found", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGroups(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groups := state.Groups()
		patternsByGroup := make(map[string][]string)
		for _, p := range state.Patterns() {
			patternsByGroup[p.Group] = append(patternsByGroup[p.Group], p.Pattern)
		}
		result := make([]statusGroup, len(groups))
		for i, g := range groups {
			// Pattern-only groups created via AddPattern leave Files as nil,
			// which encoding/json renders as `"files": null`. The frontend
			// assumes the field is always an array, so swap a nil slice for
			// an empty literal. An already-empty non-nil slice is left alone
			// (encoding/json renders it as `[]` already).
			if g.Files == nil {
				g.Files = []*FileEntry{}
			}
			result[i] = statusGroup{
				Group:    g,
				Patterns: patternsByGroup[g.Name],
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleFileContent(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}

		entry := state.FindFile(id, group)
		if entry == nil {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}

		// Binary file types are served through the raw endpoint.
		switch entry.Type {
		case FileTypePDF, FileTypeImage, FileTypeBinary:
			http.Error(w, "content endpoint not supported for binary file types; use the raw endpoint", http.StatusUnsupportedMediaType)
			return
		}

		var resp fileContentResponse
		if entry.Uploaded {
			resp = fileContentResponse{
				Content: entry.content,
				BaseDir: "",
			}
		} else {
			content, err := os.ReadFile(entry.Path) //nolint:gosec // Path is server-managed, not user-supplied
			if err != nil {
				if os.IsNotExist(err) {
					// File is gone from disk: drop it from state so the group
					// (and possibly the group itself) disappears from the UI.
					state.RemoveFilesByPath(entry.Path)
					http.Error(w, "file not found", http.StatusNotFound)
					return
				}
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			resp = fileContentResponse{
				Content: string(content),
				BaseDir: filepath.Dir(entry.Path),
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleSearch(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := strings.TrimSpace(r.URL.Query().Get("q"))
		if q == "" {
			http.Error(w, "missing search query", http.StatusBadRequest)
			return
		}

		groupName, err := ResolveGroupName(r.URL.Query().Get("group"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		limit := 50
		if v := r.URL.Query().Get("limit"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n <= 0 {
				http.Error(w, "invalid limit", http.StatusBadRequest)
				return
			}
			if n > 200 {
				n = 200
			}
			limit = n
		}

		contextLines := 2
		if v := r.URL.Query().Get("context"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil || n < 0 {
				http.Error(w, "invalid context", http.StatusBadRequest)
				return
			}
			if n > 5 {
				n = 5
			}
			contextLines = n
		}

		groups := state.Groups()
		var files []*FileEntry
		found := false
		for i := range groups {
			if groups[i].Name == groupName {
				files = append([]*FileEntry(nil), groups[i].Files...)
				found = true
				break
			}
		}
		if !found {
			http.Error(w, "group not found", http.StatusNotFound)
			return
		}

		resp := searchResponse{
			Query:   q,
			Group:   groupName,
			Limit:   limit,
			Context: contextLines,
			Results: []searchResult{},
		}

		needle := strings.ToLower(q)
		remaining := limit
		for _, entry := range files {
			if remaining == 0 {
				break
			}
			content, err := readSearchableContent(entry)
			if err != nil {
				slog.Warn("failed to read file for search", "id", entry.ID, "path", entry.Path, "error", err)
				continue
			}
			matches := findSearchMatches(content, needle, contextLines, remaining)
			if len(matches) == 0 {
				continue
			}
			resp.Results = append(resp.Results, searchResult{
				FileID:   entry.ID,
				FileName: entry.Name,
				Title:    entry.Title,
				Path:     entry.Path,
				Uploaded: entry.Uploaded,
				Matches:  matches,
			})
			resp.Total += len(matches)
			remaining -= len(matches)
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func readSearchableContent(entry *FileEntry) (string, error) {
	switch entry.Type {
	case FileTypePDF, FileTypeImage, FileTypeBinary:
		return "", fmt.Errorf("file type %q is not searchable", entry.Type)
	}
	if entry.Uploaded {
		return entry.content, nil
	}
	data, err := os.ReadFile(entry.Path) //nolint:gosec // Path is server-managed, not user-supplied
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func findSearchMatches(content, needle string, contextLines, limit int) []searchMatch {
	if needle == "" || limit <= 0 {
		return nil
	}

	lines := strings.Split(content, "\n")
	matches := make([]searchMatch, 0)
	currentHeading := ""
	fenceChar := byte(0)
	fenceLen := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		indented := leadingColumns(line) >= 4
		if fenceChar != 0 {
			if !indented && len(trimmed) > 0 && trimmed[0] == fenceChar {
				fl := len(trimmed) - len(strings.TrimLeft(trimmed, string(fenceChar)))
				if fl >= fenceLen && strings.TrimLeft(trimmed[fl:], " \t") == "" {
					fenceChar = 0
					fenceLen = 0
				}
			}
		} else if !indented {
			if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
				fc := trimmed[0]
				fl := len(trimmed) - len(strings.TrimLeft(trimmed, string(fc)))
				fenceChar = fc
				fenceLen = fl
			} else if heading := extractHeadingLine(line); heading != "" {
				currentHeading = heading
			}
		}

		index := strings.Index(strings.ToLower(line), needle)
		if index < 0 {
			continue
		}

		beforeStart := max(0, i-contextLines)
		afterEnd := min(len(lines), i+contextLines+1)
		match := searchMatch{
			Line:    i + 1,
			Column:  index + 1,
			Text:    line,
			Before:  append([]string(nil), lines[beforeStart:i]...),
			After:   append([]string(nil), lines[i+1:afterEnd]...),
			Heading: currentHeading,
			Anchor: searchAnchor{
				Kind:  "heading",
				Value: currentHeading,
			},
		}
		matches = append(matches, match)
		if len(matches) >= limit {
			break
		}
	}

	return matches
}

func extractHeadingLine(line string) string {
	if leadingColumns(line) >= 4 {
		return ""
	}
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "#") {
		return ""
	}
	hashes := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
	if hashes == 0 || hashes > 6 {
		return ""
	}
	after := trimmed[hashes:]
	if len(after) == 0 || (after[0] != ' ' && after[0] != '\t') {
		return ""
	}
	title := strings.TrimSpace(after)
	// Strip optional closing # sequence (CommonMark §4.2).
	if len(title) > 0 && title[len(title)-1] == '#' {
		i := len(title)
		for i > 0 && title[i-1] == '#' {
			i--
		}
		if i == 0 || (title[i-1] == ' ' || title[i-1] == '\t') {
			if i == 0 {
				title = ""
			} else {
				title = strings.TrimRight(title[:i], " \t")
			}
		}
	}
	return title
}

// resolveWithinBase joins rel onto base, cleans the result, and verifies it
// does not escape base via "..". It returns the cleaned absolute path, or
// ok=false if the resolved path would fall outside base. This guards the
// relative-path endpoints against directory traversal.
func resolveWithinBase(base, rel string) (string, bool) {
	abs := filepath.Clean(filepath.Join(base, rel))
	rp, err := filepath.Rel(base, abs)
	if err != nil {
		return "", false
	}
	if rp == ".." || strings.HasPrefix(rp, ".."+string(filepath.Separator)) {
		return "", false
	}
	return abs, true
}

func handleFileRaw(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}

		entry := state.FindFile(id, group)
		if entry == nil {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}

		if entry.Uploaded {
			http.Error(w, "raw assets not available for uploaded files", http.StatusNotFound)
			return
		}

		relPath := r.PathValue("path")
		absPath, ok := resolveWithinBase(filepath.Dir(entry.Path), relPath)
		if !ok {
			http.Error(w, "access denied", http.StatusForbidden)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, absPath)
	}
}

func handleFileServe(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		group, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		if id == "" {
			http.Error(w, "missing file id", http.StatusBadRequest)
			return
		}

		entry := state.FindFile(id, group)
		if entry == nil {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		if entry.Uploaded {
			http.Error(w, "raw serving not available for uploaded files", http.StatusNotFound)
			return
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, entry.Path)
	}
}

func handleOpenFile(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupName, err := resolveGroupFromPath(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var req openFileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		entry := state.FindFile(req.FileID, groupName)
		if entry == nil {
			http.Error(w, "source file not found in group", http.StatusNotFound)
			return
		}

		if entry.Uploaded {
			http.Error(w, "relative links not available for uploaded files", http.StatusBadRequest)
			return
		}

		decodedPath, err := url.PathUnescape(req.Path)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		absPath, ok := resolveWithinBase(filepath.Dir(entry.Path), decodedPath)
		if !ok {
			http.Error(w, "access denied", http.StatusForbidden)
			return
		}

		if _, err := os.Stat(absPath); err != nil {
			if os.IsNotExist(err) {
				http.Error(w, fmt.Sprintf("file not found: %s", absPath), http.StatusNotFound)
			} else {
				http.Error(w, err.Error(), http.StatusBadRequest)
			}
			return
		}

		newEntry, err := state.AddFile(absPath, groupName)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(newEntry); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleAddPattern(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req patternRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		group, err := ResolveGroupName(req.Group)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		entries, err := state.AddPattern(req.Pattern, group)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(AddPatternResponse{Matched: len(entries), Files: entries}); err != nil {
			slog.Error("failed to encode response", "error", err)
		}
	}
}

func handleRemovePattern(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req patternRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		group, err := ResolveGroupName(req.Group)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if !state.RemovePattern(req.Pattern, group) {
			http.Error(w, "pattern not found", http.StatusNotFound)
			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

func handleRestart(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		restoreFile, err := state.ExportState()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.WriteHeader(http.StatusAccepted)

		// Send restart signal after response is written
		select {
		case state.restartCh <- restoreFile:
		default:
			os.Remove(restoreFile) //nolint:errcheck
		}
	}
}

func handleShutdown(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		select {
		case state.shutdownCh <- struct{}{}:
		default:
		}
	}
}

type statusGroup struct {
	Group
	Patterns []string `json:"patterns,omitempty"`
}

func handleStatus(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groups := state.Groups()
		statusGroups := make([]statusGroup, len(groups))
		for i, g := range groups {
			statusGroups[i] = statusGroup{
				Group:    g,
				Patterns: state.PatternsForGroup(g.Name),
			}
		}

		resp := struct {
			Version  string        `json:"version"`
			Revision string        `json:"revision"`
			PID      int           `json:"pid"`
			Groups   []statusGroup `json:"groups"`
		}{
			Version:  version.Version,
			Revision: version.Revision,
			PID:      os.Getpid(),
			Groups:   statusGroups,
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			slog.Error("failed to encode status response", "error", err)
		}
	}
}

func handleVersion() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]string{
			"version":  version.Version,
			"revision": version.Revision,
		}); err != nil {
			slog.Error("failed to encode version response", "error", err)
		}
	}
}

func handleSSE(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		ch := state.Subscribe()
		defer state.Unsubscribe(ch)

		// Send server identity on connection
		fmt.Fprintf(w, "event: started\ndata: {\"pid\":%d}\n\n", os.Getpid())
		flusher.Flush()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-ch:
				if !ok {
					return
				}
				fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e.Name, e.Data)
				flusher.Flush()
			}
		}
	}
}

func handleSPA() http.HandlerFunc {
	distFS, err := fs.Sub(static.Frontend, "dist")
	if err != nil {
		slog.Error("failed to create sub filesystem", "error", err)
		os.Exit(1)
	}
	fileServer := http.FileServer(http.FS(distFS))

	return func(w http.ResponseWriter, r *http.Request) {
		// Try to serve the exact file first
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}

		f, err := distFS.Open(strings.TrimPrefix(path, "/"))
		if err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}

		// SPA fallback: serve index.html for all non-file routes
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	}
}

func (s *State) broadcastCheckboxChanged(id string, sources, overrides map[string]bool, orderedKeys []string) {
	b, err := json.Marshal(struct {
		FileID      string          `json:"fileId"`
		Sources     map[string]bool `json:"sources"`
		Overrides   map[string]bool `json:"overrides"`
		OrderedKeys []string        `json:"orderedKeys"`
	}{FileID: id, Sources: sources, Overrides: overrides, OrderedKeys: orderedKeys})
	if err != nil {
		slog.Error("broadcastCheckboxChanged", "err", err)
		return
	}
	s.sendEvent(sseEvent{
		Name: eventCheckboxChanged,
		Data: string(b),
	})
	s.markDirty()
}

func resolveGroupedFileID(state *State, r *http.Request) (string, int, error) {
	group, err := resolveGroupFromPath(r)
	if err != nil {
		return "", http.StatusBadRequest, err
	}
	id := r.PathValue("id")
	if id == "" {
		return "", http.StatusBadRequest, errors.New("missing file id")
	}
	if state.FindFile(id, group) == nil {
		return "", http.StatusNotFound, ErrFileNotFound
	}
	return id, 0, nil
}

func handleGetCheckboxes(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, status, err := resolveGroupedFileID(state, r)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		sources, overrides, orderedKeys, found := state.CheckboxState(id)
		if !found {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(struct {
			Sources     map[string]bool `json:"sources"`
			Overrides   map[string]bool `json:"overrides"`
			OrderedKeys []string        `json:"orderedKeys"`
		}{Sources: sources, Overrides: overrides, OrderedKeys: orderedKeys}); err != nil {
			slog.Error("failed to encode checkbox state response", "error", err)
		}
	}
}

func handlePutCheckbox(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, status, err := resolveGroupedFileID(state, r)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		key, err := url.PathUnescape(r.PathValue("key"))
		if err != nil {
			http.Error(w, "invalid key encoding", http.StatusBadRequest)
			return
		}

		var req struct {
			Checked bool `json:"checked"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if !state.SetCheckbox(id, key, req.Checked) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleDeleteCheckboxes(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, status, err := resolveGroupedFileID(state, r)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		if !state.UncheckAll(id) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleCheckAll(state *State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, status, err := resolveGroupedFileID(state, r)
		if err != nil {
			http.Error(w, err.Error(), status)
			return
		}
		if !state.CheckAll(id) {
			http.Error(w, "file not found", http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
