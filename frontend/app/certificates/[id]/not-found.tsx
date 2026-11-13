import Link from "next/link";

export default function CertificateNotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-xl font-semibold">Certificado no encontrado</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No existe un certificado con ese identificador.
      </p>
      <Link href="/" className="text-sm font-medium underline">
        Ver todos los certificados
      </Link>
    </div>
  );
}
