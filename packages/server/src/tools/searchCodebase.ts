import { searchCodebaseArgsSchema, type ToolHandler } from "@forge/shared";
import { searchWorkspace } from "../index/service";

/**
 * Semantic search over the workspace index (Prompt 5).
 *
 * The handler is deliberately thin: everything interesting — refreshing the
 * index before searching, embedding the query, cosine ranking — lives in
 * index/service.ts so it can also be driven without a tool call.
 */
export const searchCodebase: ToolHandler = async (call, context) => {
  const args = searchCodebaseArgsSchema.parse(call.args);
  const { results, stats } = await searchWorkspace(context.workspaceRoot, args, { signal: context.signal });
  const index = { status: stats.status, files: stats.files, chunks: stats.chunks, model: stats.model };

  if (!results.length) {
    return {
      toolCallId: call.id, ok: true,
      output: JSON.stringify({
        query: args.query, matches: 0, index,
        hint: "No chunk scored above the similarity threshold. Try different wording, drop pathPrefix, or fall back to list_dir and read_file.",
      }),
    };
  }

  return {
    toolCallId: call.id, ok: true,
    output: JSON.stringify({
      query: args.query, matches: results.length, index,
      results: results.map((result) => ({
        path: result.relativePath,
        lines: `${result.startLine}-${result.endLine}`,
        score: result.score,
        language: result.language,
        snippet: result.snippet,
      })),
      note: "Semantic matches from the workspace index. Cite path:lines when answering and use read_file for surrounding context.",
    }),
  };
};
