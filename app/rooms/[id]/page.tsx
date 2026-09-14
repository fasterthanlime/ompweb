import { RoomView } from "@/components/RoomView";

export const dynamic = "force-dynamic";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RoomView initialRoom={id} />;
}
