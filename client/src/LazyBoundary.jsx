import { Component, Suspense } from 'react';

// Wraps an on-demand chunk. After a deploy an open page may ask for a chunk
// whose hashed file no longer exists (or the network is down); without a
// boundary that rejection unmounts the whole app. Contain it and offer a
// reload, which fetches the current index.html and its chunks.
export class LazyBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="lazy-boundary-error" role="alert">
          <p>加载失败，可能是刚更新过版本或网络中断。</p>
          <button type="button" onClick={() => window.location.reload()}>刷新页面</button>
        </div>
      );
    }
    return <Suspense fallback={this.props.fallback ?? null}>{this.props.children}</Suspense>;
  }
}
