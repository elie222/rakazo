import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ShareManifest } from "@rakazo/contracts";
import { authClient } from "../lib/auth";
import { rpc } from "../lib/rpc";

export function SharePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [manifest, setManifest] = useState<ShareManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Share link not found");
      return;
    }
    void rpc.share
      .preview({ token })
      .then(setManifest)
      .catch((err) => setError(err instanceof Error ? err.message : "Share link not found"));
  }, [token]);

  async function addToWorkspace() {
    if (!token || importing) return;
    setImporting(true);
    setError(null);
    try {
      const bot = await rpc.bots.importShare({ token });
      navigate(`/app/${bot.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import bot");
    } finally {
      setImporting(false);
    }
  }

  if (!token) {
    return (
      <div className="grid h-full place-items-center bg-[#050506] px-6 text-[#85858A]">
        Share link not found
      </div>
    );
  }

  if (error && !manifest) {
    return (
      <div className="grid h-full place-items-center bg-[#050506] px-6 text-center">
        <p className="text-[15px] text-[#85858A]">{error}</p>
        <Link to="/" className="mt-4 text-[14px] text-[#ECECEE]">Home</Link>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="grid h-full place-items-center bg-[#050506] text-[#6C6C70]">Loading…</div>
    );
  }

  const user = session.data?.user;
  const signInHref = `/sign-in?next=${encodeURIComponent(`/share/${token}`)}`;

  return (
    <div className="flex min-h-full flex-col bg-[#050506] px-6 py-10 text-[#ECECEE]">
      <div className="mx-auto w-full max-w-[520px]">
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-[#F1F1F2]">
          {manifest.name}
        </h1>
        {manifest.title ? (
          <p className="mt-2 text-[16px] text-[#9A9AA0]">{manifest.title}</p>
        ) : null}
        {manifest.description ? (
          <p className="mt-4 text-[15px] leading-relaxed text-[#C8C8CC]">{manifest.description}</p>
        ) : null}
        {manifest.routines.length > 0 ? (
          <p className="mt-4 text-[14px] text-[#85858A]">
            Includes {manifest.routines.length} routine template
            {manifest.routines.length === 1 ? "" : "s"} (not active until you enable them).
          </p>
        ) : null}
        <details
          className="mt-6"
          open={showDetails}
          onToggle={(event) => setShowDetails((event.target as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-[14px] text-[#85858A]">Details</summary>
          {manifest.instructions ? (
            <p className="mt-3 text-[14px] leading-relaxed text-[#B8B8BC]">{manifest.instructions}</p>
          ) : (
            <p className="mt-3 text-[14px] text-[#6C6C70]">No extra instructions.</p>
          )}
        </details>
        <p className="mt-6 text-[13px] text-[#6C6C70]">
          Configuration only — no computer, logins, files, or chat history.
        </p>
        {error ? (
          <p role="alert" className="mt-4 text-[13px] text-[#C94244]">{error}</p>
        ) : null}
        <div className="mt-8 flex flex-col gap-3">
          {user ? (
            <button
              type="button"
              disabled={importing}
              onClick={() => void addToWorkspace()}
              className="rounded-[11px] bg-[#F1F1EF] px-4 py-3 text-[15px] text-[#17171A] disabled:opacity-40"
            >
              {importing ? "Adding…" : "Add to my workspace"}
            </button>
          ) : (
            <Link
              to={signInHref}
              className="rounded-[11px] bg-[#F1F1EF] px-4 py-3 text-center text-[15px] text-[#17171A]"
            >
              Sign in to add
            </Link>
          )}
          <Link to="/" className="text-center text-[14px] text-[#85858A]">Back</Link>
        </div>
      </div>
    </div>
  );
}
