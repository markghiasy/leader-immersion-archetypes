import Link from "next/link";
import { BrandFooter, BrandHeader } from "@/components/Brand";

export default function NotFound() {
  return (
    <div className="page">
      <BrandHeader />
      <main className="container">
        <div className="stack" style={{ paddingTop: "var(--space-7)" }}>
          <h1>We could not find that scorecard</h1>
          <p className="muted">
            The link may be incomplete, or it may have been mistyped. Check the full link, or take the quiz to get a
            scorecard of your own.
          </p>
          <Link className="button" href="/">
            Take the quiz
          </Link>
        </div>
      </main>
      <BrandFooter />
    </div>
  );
}
