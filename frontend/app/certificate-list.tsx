import Link from "next/link";
import { formatDate, getCertificates } from "@/lib/api";

export async function CertificateList() {
  const certificates = await getCertificates();

  if (certificates.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Todavía no hay certificados. Creá el primero con el formulario.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {certificates.map((certificate) => (
        <li key={certificate.id}>
          <Link
            href={`/certificates/${certificate.id}`}
            className="flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-zinc-50 sm:flex-row sm:items-center sm:justify-between dark:hover:bg-zinc-900"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {certificate.title}
              </span>
              <span className="block truncate text-sm text-zinc-500 dark:text-zinc-400">
                {certificate.recipient}
              </span>
            </span>
            <time
              dateTime={certificate.createdAt}
              className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400"
            >
              {formatDate(certificate.createdAt)}
            </time>
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
        <div
          key={i}
          className="h-16 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900"
        />
      ))}
    </div>
  );
}
