import type { JSX } from "react";
import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
} from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

// Raw HTML is dropped (no rehype-raw, skipHtml), the tree is sanitised with the
// GitHub-style default schema, and images are not rendered so a previewed file
// cannot make the browser fetch remote URLs.
const REMARK_PLUGINS = [remarkGfm] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;
const REHYPE_PLUGINS = [[rehypeSanitize, defaultSchema]] satisfies NonNullable<
  ReactMarkdownOptions["rehypePlugins"]
>;
const DISALLOWED_ELEMENTS = ["img"];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};
const MARKDOWN_CLASS =
  "text-[15px] leading-[1.5] text-[var(--personal-text)] break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--personal-border)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--personal-text-secondary)] [&_code]:font-mono [&_code]:text-[13px] [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-semibold [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--personal-radius-button)] [&_pre]:bg-[var(--personal-fill-muted)] [&_pre]:p-3 [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-[var(--personal-border)] [&_td]:px-2 [&_th]:border [&_th]:border-[var(--personal-border)] [&_th]:px-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5";

/**
 * Read-only body of a text file preview: markdown rendered and sanitised
 * exactly like the Files tab, every other text file shown as source so it can
 * never execute.
 */
export function FileTextPreview({
  text,
  markdown,
}: {
  readonly text: string;
  readonly markdown: boolean;
}): JSX.Element {
  if (markdown) {
    return (
      <div className={MARKDOWN_CLASS}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          disallowedElements={DISALLOWED_ELEMENTS}
          components={MARKDOWN_COMPONENTS}
          skipHtml
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  }
  return (
    <pre className="font-mono text-[13px] leading-[1.5] break-words whitespace-pre-wrap text-[var(--personal-text)]">
      {text}
    </pre>
  );
}
