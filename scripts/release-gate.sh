#!/usr/bin/env bash
set -euo pipefail

readonly MAX_FILE_BYTES=1048576

fail() {
  printf 'release gate: FAILED (%s)\n' "$1" >&2
  exit 1
}

fail_for_context() {
  local reason="$1"
  local context="$2"
  if [ "$context" = "history" ]; then
    fail "$reason in repository history"
  fi
  fail "$reason"
}

contains_uuid() {
  LC_ALL=C grep -Eiq \
    -- '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$1"
}

contains_email() {
  LC_ALL=C grep -Eiq \
    -- '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}' "$1"
}

contains_home_path() {
  local root_segment='root'
  LC_ALL=C grep -Eiq \
    -- "(/(users|home)/[^/[:space:]\"']+|(^|[^[:alnum:]_])/${root_segment}(/|[^[:alnum:]_]|$)|[a-z]:[\\\\/]+users[\\\\/]+[^\\\\/[:space:]\"']+)" "$1"
}

contains_disallowed_c0() {
  [ "$(LC_ALL=C tr -d '\011\012\015\040-\377' <"$1" | wc -c | tr -d '[:space:]')" -ne 0 ]
}

has_archive_magic() {
  local magic
  magic="$(LC_ALL=C od -An -tx1 -N8 -- "$1" | tr -d '[:space:]')"
  case "$magic" in
    504b0304*|504b0506*|504b0708*|1f8b*|425a68*|377abcaf271c*|526172211a0700*|526172211a070100*|fd377a585a00*|28b52ffd*|25504446*|213c617263683e0a*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_valid_utf8() {
  iconv -f UTF-8 -t UTF-8 -- "$1" >/dev/null 2>&1
}

scan_semantic_path() {
  local display_path="$1"
  local context="$2"
  local status

  if ! printf '%s' "$display_path" | LC_ALL=C grep -q '[^ -~]'; then
    case "$display_path" in
      ' '*|*'/ '*|*' '|*' /'*|*.) ;;
      *)
        if ! printf '%s\n' "$display_path" | LC_ALL=C grep -Eiq \
          -- '(^|[/\\])(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|[/\\]|$)'; then
          return 0
        fi
        ;;
    esac
  fi
  if bun "$privacy_scanner" path "$display_path" >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  case "$status" in
    10) fail_for_context "unsafe filename" "$context" ;;
    *) fail_for_context "semantic scanner failure" "$context" ;;
  esac
}

scan_semantic_content() {
  local display_path="$1"
  local content_path="$2"
  local context="$3"
  local status

  if bun "$privacy_scanner" content "$display_path" "$content_path" >/dev/null 2>&1; then
    return 0
  else
    status=$?
  fi
  case "$status" in
    10) fail_for_context "unsafe filename" "$context" ;;
    11) fail_for_context "forbidden private-data field" "$context" ;;
    12) fail_for_context "binary content present" "$context" ;;
    13) fail_for_context "invalid structured content" "$context" ;;
    *) fail_for_context "semantic scanner failure" "$context" ;;
  esac
}

validate_private_path_segments() {
  local candidate="$1"
  local context="$2"
  local normalized

  normalized="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
  case "/$normalized/" in
    */.ori/*|*/.claude/*|*/.codex/*|*/private/*|*/artifact/*|*/artifacts/*|*/runs/*|*/transcript/*|*/transcripts/*|*/tool-output/*)
      fail_for_context "forbidden private-data path" "$context"
      ;;
  esac
}

validate_path() {
  local candidate="$1"
  local context="$2"
  local normalized

  [[ "$candidate" != *$'\n'* && "$candidate" != *$'\r'* ]] \
    || fail_for_context "unsupported filename" "$context"

  scan_semantic_path "$candidate" "$context"
  validate_private_path_segments "$candidate" "$context"
  normalized="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    run|run/*|*/run|*/run/*)
      case "$normalized" in
        src/run|src/run/*) ;;
        *) fail_for_context "forbidden private-data path" "$context" ;;
      esac
      ;;
  esac
  case "$normalized" in
    *.7z|*.a|*.avi|*.bin|*.bmp|*.bz2|*.class|*.db|*.dmg|*.doc|*.docx|*.dylib|*.exe|*.gif|*.gz|*.ico|*.jar|*.jpeg|*.jpg|*.mov|*.mp3|*.mp4|*.o|*.pdf|*.png|*.rar|*.so|*.sqlite|*.sqlite3|*.tar|*.tgz|*.wav|*.webp|*.xls|*.xlsx|*.xz|*.zip|*.zst)
      fail_for_context "archive or binary file present" "$context"
      ;;
  esac

  if printf '%s\n' "$candidate" | contains_uuid /dev/stdin; then
    fail_for_context "unique identifier present in filename" "$context"
  fi
  if printf '%s\n' "$candidate" | contains_email /dev/stdin; then
    fail_for_context "email-shaped value present in filename" "$context"
  fi
  if printf '%s\n' "$candidate" | contains_home_path /dev/stdin; then
    fail_for_context "absolute home path present in filename" "$context"
  fi
}

validate_custom_content() {
  local display_path="$1"
  local content_path="$2"
  local context="$3"

  if contains_uuid "$content_path"; then
    fail_for_context "unique identifier present" "$context"
  fi
  if contains_home_path "$content_path"; then
    fail_for_context "absolute home path present" "$context"
  fi
  if contains_email "$content_path"; then
    fail_for_context "email-shaped value present" "$context"
  fi
  scan_semantic_content "$display_path" "$content_path" "$context"
}

scan_current_file() {
  local display_path="$1"
  local content_path="$2"
  local content_operand
  local size

  case "$content_path" in
    -*) content_operand="./$content_path" ;;
    *) content_operand="$content_path" ;;
  esac

  size="$(wc -c <"$content_operand" | tr -d '[:space:]')"
  [ "$size" -le "$MAX_FILE_BYTES" ] || fail "oversized file present"

  if has_archive_magic "$content_operand"; then
    fail "archive or binary file present"
  fi
  if contains_disallowed_c0 "$content_operand" || ! is_valid_utf8 "$content_operand"; then
    fail "binary content present"
  fi

  validate_custom_content "$display_path" "$content_operand" "current"

  if ! gitleaks stdin \
    --config .gitleaks.toml \
    --redact=100 \
    --no-banner \
    --no-color \
    --report-format json \
    --report-path "$scanner_report" \
    <"$content_operand" >/dev/null 2>&1; then
    fail "secret scan findings"
  fi
}

scan_current_entry() {
  local candidate="$1"
  local source="$2"

  validate_path "$candidate" "current"
  [ ! -L "$candidate" ] || fail "symbolic link present"
  if [ -d "$candidate" ]; then
    [ "$source" != "tracked" ] || fail "unsupported tracked entry"
    return 0
  fi
  [ -f "$candidate" ] || fail "missing or unsupported filesystem entry"
  scan_current_file "$candidate" "$candidate"
}

scan_history_custom() {
  local commit tree_entry metadata remainder mode object_type object_id history_path size

  git rev-list --all >"$commit_list" || fail "unable to enumerate repository history"
  while IFS= read -r commit; do
    [ -n "$commit" ] || continue
    git ls-tree -rz --full-tree "$commit" >"$tree_list" \
      || fail "unable to enumerate repository history"
    while IFS= read -r -d '' tree_entry; do
      metadata="${tree_entry%%$'\t'*}"
      history_path="${tree_entry#*$'\t'}"
      mode="${metadata%% *}"
      remainder="${metadata#* }"
      object_type="${remainder%% *}"
      object_id="${remainder##* }"

      validate_path "$history_path" "history"
      [ "$mode" != "120000" ] \
        || fail "symbolic link present in repository history"
      [ "$object_type" = "blob" ] \
        || fail "unsupported entry in repository history"

      size="$(git cat-file -s "$object_id")" \
        || fail "unable to inspect repository history"
      [ "$size" -le "$MAX_FILE_BYTES" ] \
        || fail "oversized file present in repository history"
      git cat-file blob "$object_id" >"$history_blob" \
        || fail "unable to inspect repository history"
      if has_archive_magic "$history_blob"; then
        fail "archive or binary file present in repository history"
      fi
      if contains_disallowed_c0 "$history_blob" || ! is_valid_utf8 "$history_blob"; then
        fail "binary content present in repository history"
      fi
      validate_custom_content "$history_path" "$history_blob" "history"
    done <"$tree_list"
  done <"$commit_list"
}

command -v git >/dev/null 2>&1 || fail "required tool unavailable"
command -v gitleaks >/dev/null 2>&1 || fail "required scanner unavailable"
command -v iconv >/dev/null 2>&1 || fail "required text validator unavailable"
command -v od >/dev/null 2>&1 || fail "required binary inspector unavailable"
command -v bun >/dev/null 2>&1 || fail "required semantic scanner runtime unavailable"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" \
  || fail "unable to resolve semantic scanner"
privacy_scanner="$script_dir/privacy-scan.ts"
[ -f "$privacy_scanner" ] || fail "semantic scanner unavailable"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not a git repository"
cd "$repo_root"

temp_root=''
cleanup_temp() {
  case "${temp_root##*/}" in
    membench-release-gate.*)
      [ ! -d "$temp_root" ] || rm -rf -- "$temp_root"
      ;;
  esac
}
trap cleanup_temp EXIT
trap 'exit 1' HUP INT TERM

temp_root="$(mktemp -d "${TMPDIR:-/tmp}/membench-release-gate.XXXXXX")" \
  || fail "unable to create temporary state"
tracked_list="$temp_root/tracked-list"
index_list="$temp_root/index-list"
workspace_list="$temp_root/workspace-list"
structural_list="$temp_root/structural-list"
scanner_report="$temp_root/scanner-report"
history_report="$temp_root/history-report"
commit_list="$temp_root/commit-list"
tree_list="$temp_root/tree-list"
history_blob="$temp_root/history-blob"
index_blob="$temp_root/index-blob"

for forbidden_root in \
  .ori .claude .codex private artifact artifacts run runs transcript transcripts tool-output; do
  if [ -e "$forbidden_root" ] || [ -L "$forbidden_root" ]; then
    fail "forbidden private-data path"
  fi
done

find . \
  \( -path './.git' -o \( -type d -name node_modules \) \) -prune -o -print0 \
  >"$structural_list" || fail "unable to enumerate workspace structure"
while IFS= read -r -d '' structural_entry; do
  candidate="${structural_entry#./}"
  [ "$candidate" != "." ] || continue
  scan_semantic_path "$candidate" "current"
  validate_private_path_segments "$candidate" "current"
done <"$structural_list"

git ls-files --stage -z >"$index_list" || fail "unable to enumerate Git index"
while IFS= read -r -d '' index_entry; do
  metadata="${index_entry%%$'\t'*}"
  index_path="${index_entry#*$'\t'}"
  index_mode="${metadata%% *}"
  remainder="${metadata#* }"
  index_object_id="${remainder%% *}"
  index_stage="${remainder##* }"

  validate_path "$index_path" "current"
  [ "$index_stage" = "0" ] || fail "unsupported Git index state"
  [ "$index_mode" != "120000" ] || fail "symbolic link present"
  case "$index_mode" in
    100*) ;;
    *) fail "unsupported Git index entry" ;;
  esac
  git cat-file blob "$index_object_id" >"$index_blob" \
    || fail "unable to inspect Git index"
  scan_current_file "$index_path" "$index_blob"
done <"$index_list"

git ls-files -z >"$tracked_list" || fail "unable to enumerate tracked files"
while IFS= read -r -d '' tracked_path; do
  scan_current_entry "$tracked_path" "tracked"
done <"$tracked_list"

find . \
  \( \
    -path './.git' -o \
    \( -type d -name node_modules \) -o \
    -path './dist' -o \
    -path './build' -o \
    -path './coverage' -o \
    -path './.cache' \
  \) -prune -o -print0 >"$workspace_list" \
  || fail "unable to enumerate workspace entries"
while IFS= read -r -d '' workspace_entry; do
  candidate="${workspace_entry#./}"
  [ "$candidate" != "." ] || continue
  scan_current_entry "$candidate" "workspace"
done <"$workspace_list"

if ! gitleaks dir . \
  --config .gitleaks.toml \
  --redact=100 \
  --no-banner \
  --no-color \
  --report-format json \
  --report-path "$scanner_report" \
  >/dev/null 2>&1; then
  fail "secret scan findings"
fi

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  scan_history_custom
  if ! gitleaks git . \
    --config .gitleaks.toml \
    --redact=100 \
    --no-banner \
    --no-color \
    --log-opts="--all" \
    --report-format json \
    --report-path "$history_report" \
    >/dev/null 2>&1; then
    fail "secret scan findings in repository history"
  fi
fi

printf 'release gate: PASS\n'
