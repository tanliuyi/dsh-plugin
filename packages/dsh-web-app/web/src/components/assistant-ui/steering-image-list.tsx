import type { DshMessagePart } from "@/dsh/messages";

export type SteeringImage = Extract<DshMessagePart, { type: "image" }>;
type LoadedSteeringImage = SteeringImage & { src: string };

export function SteeringImageList({
  images,
}: {
  images: readonly SteeringImage[];
}) {
  const visibleImages = images.filter(
    (image): image is LoadedSteeringImage =>
      typeof image.src === "string" && image.src !== "",
  );
  if (visibleImages.length === 0) return null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {visibleImages.map((image) => (
        <img
          key={image.attachmentId}
          src={image.src}
          alt={image.name ?? "Image attachment"}
          className="border-border/60 max-h-36 max-w-full rounded-[22px] border object-contain"
        />
      ))}
    </div>
  );
}
