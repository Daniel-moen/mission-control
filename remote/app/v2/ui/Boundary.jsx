import { Component } from 'react';

// A page that throws shows this instead of taking the whole app down with it
// (React unmounts everything above an uncaught render error).
export default class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('v2 page error:', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-8 text-center" role="alert" data-page-error>
        <div>
          <div className="text-[1.05rem] font-semibold text-ink">This page hit a snag</div>
          <p className="mt-1.5 max-w-[40ch] text-[0.86rem] text-ink3">{String(this.state.error?.message || this.state.error)}</p>
          <button onClick={() => this.setState({ error: null })} className="mt-4 h-10 rounded-full bg-ink px-5 text-[0.86rem] font-semibold text-page">
            Try again
          </button>
        </div>
      </div>
    );
  }
}
