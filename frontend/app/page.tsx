import { Suspense } from "react";
import { CertificateForm } from "./certificate-form";
import { CertificateList, CertificateListSkeleton } from "./certificate-list";

const STEPS = [
  [
    "01",
    "Certificar",
    "El servidor calcula el SHA-256 del archivo y lo une a los metadatos en un manifiesto.",
  ],
  [
    "02",
    "Anclar",
    "La huella del manifiesto se registra en un contrato público de Avalanche.",
  ],
  [
    "03",
    "Verificar",
    "Volvé a subir el archivo: un solo bit distinto y la verificación falla.",
  ],
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-12 sm:px-6 sm:py-16">
      <section className="flex max-w-3xl flex-col gap-5">
        <p className="eyebrow">Integridad verificable</p>
        <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight text-balance sm:text-5xl">
          Probá que un archivo satelital no cambió.
        </h1>
        <p className="max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
          SpaceProof certifica un archivo junto con sus metadatos y ancla su
          huella en Avalanche. Cualquiera puede comprobar después, sin confiar
          en nosotros, que sigue siendo exactamente el mismo.
        </p>
        <ol className="mt-2 grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
          {STEPS.map(([number, title, text]) => (
            <li key={number} className="flex flex-col gap-1.5 bg-panel p-4">
              <span className="eyebrow">{number}</span>
              <span className="text-sm font-semibold">{title}</span>
              <span className="hint">{text}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-labelledby="new-certificate" className="flex flex-col gap-4">
          <h2 id="new-certificate" className="text-lg font-semibold">
            Certificar un archivo
          </h2>
          <div className="card p-5">
            <CertificateForm />
          </div>
        </section>

        <section aria-labelledby="certificates" className="flex flex-col gap-4">
          <h2 id="certificates" className="text-lg font-semibold">
            Certificados emitidos
          </h2>
          <Suspense fallback={<CertificateListSkeleton />}>
            <CertificateList />
          </Suspense>
        </section>
      </div>
    </main>
  );
}
