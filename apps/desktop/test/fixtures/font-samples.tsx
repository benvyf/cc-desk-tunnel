import { createRoot } from 'react-dom/client';
import RichText from '../../src/RichText.tsx';

export function mount() {
  const host = document.createElement('section');
  host.className = 'font-size-samples';
  document.querySelector('.page-body')!.append(host);
  createRoot(host).render(
    <>
      <div className="message user">
        <div className="message-content">
          <p>用户消息字号预览，长文本应当自然换行。</p>
        </div>
      </div>
      <div className="message assistant">
        <div className="message-content">
          <RichText text={'普通正文与 `inlineCode`。\n\n```js\nconst example = 42;\n```'} />
        </div>
      </div>
      <div className="tool-detail">
        <pre className="tool-input">{'- before\n+ after'}</pre>
        <pre className="tool-output">工具输出</pre>
      </div>
    </>,
  );
}
