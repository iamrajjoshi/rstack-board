import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../shared/types';
import { timeAgo } from './format';
import { Avatar } from './marks';

/** A message's Markdown. Rendered without raw HTML: message text is untrusted input from agents. */
export function MessageText({ text }: { text: string }) {
  return (
    <div className="text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
            />
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** The avatar and `author · where · time` line shared by the feed and the thread pane. */
export function MessageFrame({
  message,
  where,
  time = message.createdAt,
  children,
}: {
  message: Message;
  where?: string;
  time?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Avatar name={message.author} />
      <div className="body">
        <div className="meta">
          <span className="author">{message.author}</span>
          {where && <span className="where">in #{where}</span>}
          <time title={new Date(time).toLocaleString()}>{timeAgo(time)}</time>
        </div>
        {children}
      </div>
    </>
  );
}
