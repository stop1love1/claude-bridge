// Package upload validates and lands files staged at
// `<bridge>/.uploads/<sessionId>/`. The bridge stages the file, then
// hands its absolute path to the chat composer; claude can `Read` /
// `Bash` against that path. Every helper here exists to keep that
// trust boundary safe — see libs/uploadGuards.ts for the original
// rationale.
package upload

import (
	"path/filepath"
	"regexp"
	"strings"
)

// MaxBytes caps any one upload at 25 MB. Big enough for screenshots
// and small docs, small enough that a hostile client can't OOM the
// bridge by streaming gigabytes through formData(). Mirrors the TS
// MAX_UPLOAD_BYTES constant.
const MaxBytes int64 = 25 * 1024 * 1024

// blockedExtensions is the lower-case extension blocklist (with leading
// dot). A `.dll` upload is uncommon enough that blocking it is fine,
// and a hostile chain (Read → exec via shim) isn't worth the
// convenience. Includes Windows reserved exec types, scripting
// languages, JVM containers, disk images, and active web content.
//
// Mirrors the TS BLOCKED_EXTENSIONS set exactly.
var blockedExtensions = map[string]struct{}{
	".exe": {}, ".bat": {}, ".cmd": {}, ".com": {}, ".scr": {},
	".msi": {}, ".msp": {}, ".dll": {}, ".sys": {}, ".lnk": {},
	".url": {}, ".appx": {}, ".appxbundle": {}, ".msu": {},
	".msix": {}, ".msixbundle": {}, ".reg": {},
	".ps1": {}, ".psm1": {}, ".psd1": {},
	".vbs": {}, ".vbe": {}, ".wsf": {}, ".wsh": {}, ".hta": {}, ".chm": {},
	".js": {}, ".jse": {},
	".jar": {}, ".class": {},
	".sh": {},
	".iso": {}, ".img": {}, ".vhd": {}, ".vhdx": {},
	".html": {}, ".htm": {}, ".xhtml": {}, ".shtml": {},
	".svg": {}, ".svgz": {}, ".mhtml": {},
}

// reservedDeviceNames are Windows special filenames that can't be
// created — match against the filename's stem (part before first dot)
// so `CON.txt` is reserved like `CON`.
var reservedDeviceNames = map[string]struct{}{
	"con": {}, "prn": {}, "aux": {}, "nul": {},
	"com1": {}, "com2": {}, "com3": {}, "com4": {}, "com5": {},
	"com6": {}, "com7": {}, "com8": {}, "com9": {},
	"lpt1": {}, "lpt2": {}, "lpt3": {}, "lpt4": {}, "lpt5": {},
	"lpt6": {}, "lpt7": {}, "lpt8": {}, "lpt9": {},
}

// illegalCharsRE matches Windows-illegal chars that get replaced with
// underscore. Same regex shape as libs/uploadGuards.ts.
var illegalCharsRE = regexp.MustCompile(`[\\/:*?"<>|]`)

// dotSpaceTrimRE strips leading/trailing dots and spaces — Windows
// silently strips these, letting `evil.exe.` masquerade as `evil.exe`.
var dotSpaceTrimRE = regexp.MustCompile(`^[.\s]+|[.\s]+$`)

// SanitizeName strips illegal Windows chars and surrounding `.` /
// spaces. Returns "" when nothing salvageable remains; the caller
// turns that into 400 file required.
func SanitizeName(raw string) string {
	cleaned := illegalCharsRE.ReplaceAllString(raw, "_")
	cleaned = dotSpaceTrimRE.ReplaceAllString(cleaned, "")
	return cleaned
}

// ExtractExtension returns the lower-case extension (with leading
// dot), or "" when none. Uses the LAST dot so `archive.tar.gz` → `.gz`.
// Leading-dot-only files (e.g. `.bashrc`) have no extension.
func ExtractExtension(name string) string {
	idx := strings.LastIndex(name, ".")
	if idx <= 0 {
		return ""
	}
	return strings.ToLower(name[idx:])
}

// extractStem returns the part before the first dot, lower-cased.
// Used for reserved-device-name matching.
func extractStem(name string) string {
	idx := strings.Index(name, ".")
	if idx == -1 {
		return strings.ToLower(name)
	}
	return strings.ToLower(name[:idx])
}

// HasBlockedExtension reports whether name's extension is in the
// blocklist.
func HasBlockedExtension(name string) bool {
	ext := ExtractExtension(name)
	if ext == "" {
		return false
	}
	_, blocked := blockedExtensions[ext]
	return blocked
}

// IsReservedDeviceName reports whether name's stem is a Windows
// reserved device name.
func IsReservedDeviceName(name string) bool {
	_, reserved := reservedDeviceNames[extractStem(name)]
	return reserved
}

// GuardReason discriminates the validation failure. JSON-tagged so the
// HTTP response can include it for diagnostics.
type GuardReason string

const (
	ReasonEmptyName       GuardReason = "empty-name"
	ReasonBlockedExt      GuardReason = "blocked-extension"
	ReasonReservedName    GuardReason = "reserved-name"
	ReasonOutsideDir      GuardReason = "outside-upload-dir"
)

// GuardResult is the outcome of ValidateName.
type GuardResult struct {
	OK        bool        `json:"ok"`
	Sanitized string      `json:"sanitized,omitempty"`
	Reason    GuardReason `json:"reason,omitempty"`
	Detail    string      `json:"detail,omitempty"`
}

// ValidateName sanitizes raw, then runs every check in order. Caller
// maps the failure reason onto an HTTP status (400 / 415).
//
// Path containment is checked separately via AssertInsideUploadDir
// because it requires the resolved upload directory.
func ValidateName(raw string) GuardResult {
	sanitized := SanitizeName(raw)
	if sanitized == "" {
		return GuardResult{Reason: ReasonEmptyName}
	}
	if IsReservedDeviceName(sanitized) {
		return GuardResult{Reason: ReasonReservedName, Detail: sanitized}
	}
	if HasBlockedExtension(sanitized) {
		return GuardResult{Reason: ReasonBlockedExt, Detail: ExtractExtension(sanitized)}
	}
	return GuardResult{OK: true, Sanitized: sanitized}
}

// AssertInsideUploadDir is the final defense-in-depth check on the
// resolved write path. Even with a sanitized name, paranoia says: the
// resolved path must stay inside uploadDir (with the separator
// appended so `/uploads/abc` doesn't accept `/uploads/abc-evil`).
func AssertInsideUploadDir(uploadDir, candidatePath string) bool {
	resolvedDir, err := filepath.Abs(uploadDir)
	if err != nil {
		return false
	}
	resolvedCandidate, err := filepath.Abs(candidatePath)
	if err != nil {
		return false
	}
	if resolvedCandidate == resolvedDir {
		return true
	}
	return strings.HasPrefix(resolvedCandidate, resolvedDir+string(filepath.Separator))
}
