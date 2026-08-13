/* Static chrome. Swapping /public/logo.svg rebrands the header everywhere. */
export function BrandHeader() {
  return (
    <header style={{ padding: "var(--space-5) var(--space-4) 0", maxWidth: "var(--content-width)", margin: "0 auto", width: "100%" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.svg" alt="Leader Archetype" className="logo" width={168} height={32} />
    </header>
  );
}

export function BrandFooter() {
  return <footer className="footer">Leader Archetype</footer>;
}
