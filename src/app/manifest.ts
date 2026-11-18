import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CareerOS — Personal AI Career Command Center",
    short_name: "CareerOS",
    description:
      "Private, AI-powered career management assistant for organizing job applications, Gmail & Google Calendar sync, immutable timelines, and daily AI briefings.",
    start_url: "/",
    display: "standalone",
    background_color: "#090d16",
    theme_color: "#0284c7",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/icon-192.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-192.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
