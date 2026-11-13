import Link from "next/link";

export default function CertificateNotFound() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Certificado no encontrado</h1>
      <p className="text-sm text-muted">
        No existe un certificado con ese identificador.
      </p>
      <Link href="/" className="link text-sm">
        Ver todos los certificados
      </Link>
    </div>
  );
}
