import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Claude's replies as GitHub-flavoured Markdown. Raw HTML in the text is shown as text, never rendered. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
