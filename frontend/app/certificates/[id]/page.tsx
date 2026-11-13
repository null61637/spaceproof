import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ApiError, formatDate, getCertificate } from "@/lib/api";

export default function CertificatePage({
  params,
}: PageProps<"/certificates/[id]">) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-10 sm:px-6">
      <Link
        href="/"
        className="text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Volver a certificados
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <CertificateDetail params={params} />
      </Suspense>
    </main>
  );
}

async function CertificateDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let certificate;
  try {
    certificate = await getCertificate(id);
  } catch (error) {
    // 400 = malformed id, 404 = unknown id: both mean "no such certificate".
    if (error instanceof ApiError && [400, 404].includes(error.status)) {
      notFound();
    }
    throw error;
  }

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold break-words">
          {certificate.title}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400">
          Emitido a {certificate.recipient}
        </p>
      </header>

      <dl className="grid gap-4 rounded-lg border border-zinc-200 p-4 text-sm sm:grid-cols-[10rem_1fr] dark:border-zinc-800">
        <Row label="ID">
          <code className="font-mono break-all">{certificate.id}</code>
        </Row>
        <Row label="Fecha de emisión">
          <time dateTime={certificate.createdAt}>
            {formatDate(certificate.createdAt)}
          </time>
        </Row>
        <Row label="Hash SHA-256">
          <code className="font-mono break-all">{certificate.contentHash}</code>
        </Row>
        <Row label="Transacción">
          {certificate.txHash ? (
            <code className="font-mono break-all">{certificate.txHash}</code>
          ) : (
            <span className="text-zinc-500 dark:text-zinc-400">
              Todavía no registrado en blockchain
            </span>
          )}
        </Row>
      </dl>
    </article>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-medium text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div
      role="status"
      aria-label="Cargando certificado"
      className="flex flex-col gap-4"
    >
      <div className="h-8 w-2/3 animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
      <div className="h-40 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
    </div>
  );
}
