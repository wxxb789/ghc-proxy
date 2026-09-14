// Copyright 2025 OpenAI. SPDX-License-Identifier: Apache-2.0
// See THIRD_PARTY_NOTICES.md for the license.
// Pinned from openai/codex commit 6478a751fde8884b2fdc76486fe23175a8e795d4
// (`codex-rs/core/assets/tools/apply_patch.lark`).
// The bridge compares the complete definition; it does not parse arbitrary
// Lark or accept a caller-supplied lookalike grammar.
export const APPLY_PATCH_LARK_GRAMMAR = String.raw`start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
`

export function isPinnedApplyPatchGrammar(definition: string): boolean {
  return definition === APPLY_PATCH_LARK_GRAMMAR
}
