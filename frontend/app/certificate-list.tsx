import Link from "next/link";
import { getCertificates } from "@/lib/api";
import { formatDate } from "@/lib/certificates";

export async function CertificateList() {
  const certificates = await getCertificates();

  if (certificates.length === 0) {
    return (
      <p className="hint rounded-xl border border-dashed border-line px-4 py-12 text-center">
        Todavía no hay certificados. Certificá el primer archivo con el
        formulario.
      </p>
    );
  }

  return (
    <ul className="card divide-y divide-line overflow-hidden">
      {certificates.map((certificate) => (
        <li key={certificate.id}>
          <Link
            href={`/certificates/${certificate.id}`}
            className="flex flex-col gap-1 px-4 py-3.5 transition-colors hover:bg-panel-raised"
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium">
                {certificate.title}
              </span>
              <time
                dateTime={certificate.createdAt}
                className="hint shrink-0"
              >
                {formatDate(certificate.createdAt)}
              </time>
            </span>
            <span className="hash truncate text-xs text-muted">
              {certificate.contentHash}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function CertificateListSkeleton() {
  return (
    <div
      role="status"
      aria-label="Cargando certificados"
      className="flex flex-col gap-2"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton h-16" />
      ))}
    </div>
  );
}
