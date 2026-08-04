/**
 * The tool catalogue both boundaries are probed against.
 *
 * Kept as data, separate from the probing logic, so adding a tool is a
 * literal — no control flow to touch. `scripts/probes/tool-support.ts` is the
 * only consumer today.
 *
 * Each case has to carry enough to *prove* the tool worked, not just that it
 * was accepted, so alongside the declaration it names:
 *   - `prompt` — a request the model cannot satisfy without the tool
 *   - `proof`  — the item/block types that appear when it does
 *   - `kind`   — who executes it, which decides what proof means
 */

/** Who runs the tool once the model decides to use it. */
export type ToolKind
  /** Upstream executes it and returns a result. */
  = | 'server'
  /** The model emits a call; the caller executes it. */
    | 'client'
  /** Not a builtin — the baseline that proves the harness itself works. */
    | 'control'

export interface ToolCase {
  name: string
  kind: ToolKind
  /** The tool declaration, exactly as a client would send it. */
  tool: Record<string, unknown>
  /** A prompt that cannot be answered without the tool. */
  prompt: string
  /** Item/content-block types proving the tool ran or was called. */
  proof: Array<string>
  /** Expected tool name on the emitted call, when it differs from the type. */
  callName?: string
}

// ── /responses — OpenAI Responses builtin surface ──

export const RESPONSES_TOOL_CASES: Array<ToolCase> = [
  {
    name: 'function (control)',
    kind: 'control',
    tool: {
      type: 'function',
      name: 'get_weather',
      description: 'Get the weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    prompt: 'What is the weather in Paris? Use the tool.',
    proof: ['function_call'],
    callName: 'get_weather',
  },
  {
    name: 'web_search',
    kind: 'server',
    tool: { type: 'web_search' },
    prompt: 'Search the web for the latest released version of the Bun JavaScript runtime. One sentence, cite the URL.',
    proof: ['web_search_call'],
  },
  {
    name: 'web_search_2025_08_26',
    kind: 'server',
    tool: { type: 'web_search_2025_08_26' },
    prompt: 'Search the web for the latest released version of the Deno runtime. One sentence, cite the URL.',
    proof: ['web_search_call'],
  },
  {
    name: 'web_search_preview',
    kind: 'server',
    tool: { type: 'web_search_preview' },
    prompt: 'Search the web for the current Node.js LTS version. One sentence, cite the URL.',
    proof: ['web_search_call'],
  },
  {
    name: 'web_search_preview_2025_03_11',
    kind: 'server',
    tool: { type: 'web_search_preview_2025_03_11' },
    prompt: 'Search the web for the current TypeScript version. One sentence, cite the URL.',
    proof: ['web_search_call'],
  },
  {
    name: 'code_interpreter',
    kind: 'server',
    tool: { type: 'code_interpreter', container: { type: 'auto' } },
    prompt: 'Use the code interpreter to compute the 47th Fibonacci number. Show the result.',
    proof: ['code_interpreter_call'],
  },
  {
    name: 'image_generation',
    kind: 'server',
    tool: { type: 'image_generation' },
    prompt: 'Generate an image of a plain red cube on a white background.',
    proof: ['image_generation_call'],
  },
  {
    name: 'file_search',
    kind: 'server',
    tool: { type: 'file_search', vector_store_ids: ['vs_probe_nonexistent'] },
    prompt: 'Search the attached files for the word "quota".',
    proof: ['file_search_call'],
  },
  {
    name: 'mcp',
    kind: 'server',
    tool: { type: 'mcp', server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp', require_approval: 'never' },
    prompt: 'List the tools available from the deepwiki MCP server.',
    proof: ['mcp_list_tools', 'mcp_call'],
  },
  {
    name: 'computer_use_preview',
    kind: 'client',
    tool: { type: 'computer_use_preview', display_width: 1024, display_height: 768, environment: 'browser' },
    prompt: 'Take a screenshot of the current screen.',
    proof: ['computer_call'],
  },
  {
    name: 'local_shell',
    kind: 'client',
    tool: { type: 'local_shell' },
    prompt: 'Run the command `uname -a` using the shell tool.',
    proof: ['local_shell_call'],
  },
  {
    name: 'custom apply_patch',
    kind: 'client',
    tool: { type: 'custom', name: 'apply_patch', description: 'Use the `apply_patch` tool to edit files' },
    prompt: 'Use the apply_patch tool to append a line "hello" to README.md.',
    proof: ['custom_tool_call'],
    callName: 'apply_patch',
  },
  {
    name: 'custom shell',
    kind: 'client',
    tool: { type: 'custom', name: 'shell', description: 'Run a shell command' },
    prompt: 'Use the shell tool to run `uname -a`.',
    proof: ['custom_tool_call'],
    callName: 'shell',
  },
]

// ── /v1/messages — Anthropic builtin surface ──

export const MESSAGES_TOOL_CASES: Array<ToolCase> = [
  {
    name: 'function (control)',
    kind: 'control',
    tool: {
      name: 'get_weather',
      description: 'Get the weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    prompt: 'What is the weather in Paris? Use the tool.',
    proof: ['tool_use'],
    callName: 'get_weather',
  },
  {
    name: 'bash_20250124',
    kind: 'client',
    tool: { type: 'bash_20250124', name: 'bash' },
    prompt: 'Run the command `uname -a` using the bash tool.',
    proof: ['tool_use'],
    callName: 'bash',
  },
  {
    name: 'text_editor_20250124',
    kind: 'client',
    tool: { type: 'text_editor_20250124', name: 'str_replace_editor' },
    prompt: 'View the file /tmp/notes.txt using the editor tool.',
    proof: ['tool_use'],
    callName: 'str_replace_editor',
  },
  {
    name: 'text_editor_20250429',
    kind: 'client',
    tool: { type: 'text_editor_20250429', name: 'str_replace_based_edit_tool' },
    prompt: 'View the file /tmp/notes.txt using the editor tool.',
    proof: ['tool_use'],
    callName: 'str_replace_based_edit_tool',
  },
  {
    name: 'text_editor_20250728',
    kind: 'client',
    tool: { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' },
    prompt: 'View the file /tmp/notes.txt using the editor tool.',
    proof: ['tool_use'],
    callName: 'str_replace_based_edit_tool',
  },
  {
    name: 'memory_20250818',
    kind: 'client',
    tool: { type: 'memory_20250818', name: 'memory' },
    prompt: 'Check your memory directory for anything you have stored.',
    proof: ['tool_use'],
    callName: 'memory',
  },
  {
    name: 'computer_20250124',
    kind: 'client',
    tool: { type: 'computer_20250124', name: 'computer', display_width_px: 1024, display_height_px: 768, display_number: 1 },
    prompt: 'Take a screenshot of the current screen.',
    proof: ['tool_use'],
    callName: 'computer',
  },
  {
    name: 'custom',
    kind: 'client',
    tool: {
      type: 'custom',
      name: 'my_custom_tool',
      description: 'Echo a value back',
      input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    },
    prompt: 'Use my_custom_tool to echo the value "probe".',
    proof: ['tool_use'],
    callName: 'my_custom_tool',
  },
  {
    name: 'web_search_20250305',
    kind: 'server',
    tool: { type: 'web_search_20250305', name: 'web_search' },
    prompt: 'Search the web for the latest Bun version.',
    proof: ['server_tool_use', 'web_search_tool_result'],
  },
  {
    name: 'web_search_20260209',
    kind: 'server',
    tool: { type: 'web_search_20260209', name: 'web_search' },
    prompt: 'Search the web for the latest Bun version.',
    proof: ['server_tool_use', 'web_search_tool_result'],
  },
  {
    name: 'web_fetch_20250910',
    kind: 'server',
    tool: { type: 'web_fetch_20250910', name: 'web_fetch' },
    prompt: 'Fetch https://bun.sh/ and tell me the headline.',
    proof: ['server_tool_use', 'web_fetch_tool_result'],
  },
  {
    name: 'web_fetch_20260209',
    kind: 'server',
    tool: { type: 'web_fetch_20260209', name: 'web_fetch' },
    prompt: 'Fetch https://bun.sh/ and tell me the headline.',
    proof: ['server_tool_use', 'web_fetch_tool_result'],
  },
  {
    name: 'code_execution_20250522',
    kind: 'server',
    tool: { type: 'code_execution_20250522', name: 'code_execution' },
    prompt: 'Use the code execution tool to compute the 47th Fibonacci number.',
    proof: ['server_tool_use', 'code_execution_tool_result'],
  },
  {
    name: 'code_execution_20250825',
    kind: 'server',
    tool: { type: 'code_execution_20250825', name: 'code_execution' },
    prompt: 'Use the code execution tool to compute the 47th Fibonacci number.',
    proof: ['server_tool_use', 'code_execution_tool_result', 'bash_code_execution_tool_result'],
  },
  {
    name: 'code_execution_20260120',
    kind: 'server',
    tool: { type: 'code_execution_20260120', name: 'code_execution' },
    prompt: 'Use the code execution tool to compute the 47th Fibonacci number.',
    proof: ['server_tool_use', 'code_execution_tool_result', 'bash_code_execution_tool_result'],
  },
  {
    name: 'tool_search_tool_bm25',
    kind: 'server',
    tool: { type: 'tool_search_tool_bm25', name: 'tool_search_tool_bm25' },
    prompt: 'Search your available tools for anything that can read a file, then say what you found.',
    proof: ['server_tool_use', 'tool_search_tool_result'],
  },
  {
    name: 'tool_search_tool_bm25_20251119',
    kind: 'server',
    tool: { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
    prompt: 'Search your available tools for anything that can read a file, then say what you found.',
    proof: ['server_tool_use', 'tool_search_tool_result'],
  },
  {
    name: 'tool_search_tool_regex',
    kind: 'server',
    tool: { type: 'tool_search_tool_regex', name: 'tool_search_tool_regex' },
    prompt: 'Search your available tools for anything that can read a file, then say what you found.',
    proof: ['server_tool_use', 'tool_search_tool_result'],
  },
  {
    name: 'tool_search_tool_regex_20251119',
    kind: 'server',
    tool: { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
    prompt: 'Search your available tools for anything that can read a file, then say what you found.',
    proof: ['server_tool_use', 'tool_search_tool_result'],
  },
  {
    name: 'mcp_toolset',
    kind: 'server',
    tool: { type: 'mcp_toolset', name: 'mcp_toolset', server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp' },
    prompt: 'List the tools available from the deepwiki MCP server.',
    proof: ['mcp_tool_use', 'mcp_tool_result'],
  },
  {
    name: 'mcp-client-2025-11-20',
    kind: 'server',
    tool: { type: 'mcp-client-2025-11-20', name: 'mcp_client', server_label: 'deepwiki', server_url: 'https://mcp.deepwiki.com/mcp' },
    prompt: 'List the tools available from the deepwiki MCP server.',
    proof: ['mcp_tool_use', 'mcp_tool_result'],
  },
]
