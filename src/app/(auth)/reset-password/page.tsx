import type { Metadata } from "next";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage(props: PageProps<"/reset-password">) {
  const { token } = await props.searchParams;
  return <ResetForm token={typeof token === "string" ? token : ""} />;
}
