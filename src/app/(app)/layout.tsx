import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { getCurrentUser, publicUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AppShell user={publicUser(user)}>{children}</AppShell>;
}
