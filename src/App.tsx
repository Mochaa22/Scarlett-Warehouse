import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  errorMessage: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { errorMessage: null };

  static getDerivedStateFromError(error: Error): State {
    return { errorMessage: error.message || 'Terjadi kesalahan sinkronisasi cloud.' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Cloud bridge boundary error:', error, info);
  }

  render(): ReactNode {
    if (!this.state.errorMessage) {
      return this.props.children ?? null;
    }

    return (
      <div
        role="alert"
        style={{
          position: 'fixed',
          bottom: '16px',
          left: '16px',
          zIndex: 9999,
          maxWidth: '420px',
          background: '#fef2f2',
          color: '#991b1b',
          border: '1px solid #fecaca',
          borderRadius: '10px',
          padding: '12px 14px',
          fontSize: '13px',
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.14)',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: '4px' }}>Sinkronisasi Cloud Membutuhkan Perhatian</div>
        <div style={{ wordBreak: 'break-word', marginBottom: '8px' }}>{this.state.errorMessage}</div>
        <button
          type="button"
          onClick={() => this.setState({ errorMessage: null })}
          style={{
            padding: '5px 10px',
            borderRadius: '6px',
            border: '1px solid #fca5a5',
            background: '#ffffff',
            color: '#991b1b',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Tutup
        </button>
      </div>
    );
  }
}

export default function App() {
  return <ErrorBoundary />;
}
