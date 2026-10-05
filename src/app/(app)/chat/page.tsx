import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { ChatView } from "./ChatView";

export default function ChatPage() {
  return (
    <Suspense fallback={<Spinner />}>
      <ChatView />
    </Suspense>
  );
}
