'use client';

/** A screen failed to render: say so and offer a retry, instead of a blank page. */
export default function ScreenError({ reset }: { error: Error; reset(): void }) {
  return (
    <div className="page">
      <section className="card" role="alert" style={{ marginTop: 24 }}>
        <h1 className="title" style={{ fontSize: '1.375rem' }}>
          This screen hit a problem
        </h1>
        <p className="muted">Nothing was changed. Try again; if it keeps happening, sign out and back in.</p>
        <button className="btn sm" onClick={reset}>
          Try again
        </button>
      </section>
    </div>
  );
}
