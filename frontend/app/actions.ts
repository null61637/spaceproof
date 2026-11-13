"use server";

import { redirect } from "next/navigation";
import { ApiError, createCertificate } from "@/lib/api";

export type CreateCertificateState = {
  error?: string;
  values: { title: string; recipient: string };
};

export async function createCertificateAction(
  _prev: CreateCertificateState,
  formData: FormData,
): Promise<CreateCertificateState> {
  const values = {
    title: String(formData.get("title") ?? "").trim(),
    recipient: String(formData.get("recipient") ?? "").trim(),
  };

  let id: string;
  try {
    const certificate = await createCertificate(values);
    id = certificate.id;
  } catch (error) {
    return {
      values,
      error:
        error instanceof ApiError
          ? error.message
          : "No se pudo conectar con el servidor. Intentá de nuevo.",
    };
  }

  // Outside try/catch: redirect() works by throwing.
  redirect(`/certificates/${id}`);
}
