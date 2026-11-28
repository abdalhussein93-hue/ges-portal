import { defineRailway, github, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "ges-portal";
export default defineRailway(() => {
  // Settings that used to be in railway.json (Railway reads this file only on `railway config apply`).
  // The source follows the main branch - never a fixed commit, so applying can never roll the code back.
  const gesPortal = service("ges-portal", {
    source: github("abdalhussein93-hue/ges-portal", { branch: "main", upstreamUrl: "https://github.com/abdalhussein93-hue/ges-portal" }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    replicas: { "sfo": 1 },
  });

  return project("strong-flexibility", {
    variables: { managed: false },
    resources: [gesPortal],
  });
});
