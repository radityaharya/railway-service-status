// index.tsx (Bun v1.2 runtime)
import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());
app.get("/", (c) => c.text("Hello world!"));
app.get("/api/health", (c) => c.json({ status: "ok" }));

interface RailwayService {
  projectId: string;
  projectName: string;
  serviceId: string;
  serviceName: string;
  deploymentId: string;
  status: string;
  staticUrl: string;
  deploymentStopped: boolean;
}

// Define interface for GraphQL response
interface GraphQLResponse {
  data?: {
    projects: {
      edges: Array<{
        node: {
          id: string;
          name: string;
          services: {
            edges: Array<{
              node: {
                id: string;
                name: string;
                serviceInstances: {
                  edges: Array<{
                    node: {
                      latestDeployment?: {
                        id: string;
                        status: string;
                        staticUrl: string;
                        deploymentStopped: boolean;
                      };
                    };
                  }>;
                };
              };
            }>;
          };
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: Array<{
    message: string;
    locations?: Array<{
      line: number;
      column: number;
    }>;
  }>;
}

async function getRailwayServiceInfo(
  apiToken: string
): Promise<RailwayService[]> {
  const graphqlEndpoint = "https://backboard.railway.app/graphql/v2";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiToken}`,
  };

  const allServices: RailwayService[] = [];
  let hasNextPage = true;
  let afterCursor = null;

  while (hasNextPage) {
    const query = `
      query GetServices($after: String) {
        projects(first: 50, after: $after) {
          edges {
            node {
              id
              name
              services {
                edges {
                  node {
                    id
                    name
                    serviceInstances {
                      edges{
                        node{
                          latestDeployment{
                            id
                            status
                            staticUrl
                            deploymentStopped
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `;

    const variables = {
      after: afterCursor,
    };

    try {
      const response = await fetch(graphqlEndpoint, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `GraphQL request failed: ${response.status} ${response.statusText}, ${errorText}`
        );
      }

      const data = (await response.json()) as GraphQLResponse;

      if (data.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }

      const projects = data.data?.projects.edges;
      if (!projects || projects.length == 0) {
        hasNextPage = false;
        break;
      }
      for (const projectEdge of projects) {
        const project = projectEdge.node;
        if (!project.services || !project.services.edges) {
          continue;
        }
        for (const serviceEdge of project.services.edges) {
          const service = serviceEdge.node;
          if (
            !service.serviceInstances ||
            !service.serviceInstances.edges ||
            service.serviceInstances.edges.length == 0
          ) {
            continue;
          }
          const deployment =
            service.serviceInstances.edges[0].node.latestDeployment;

          if (deployment) {
            allServices.push({
              projectId: project.id,
              projectName: project.name,
              serviceId: service.id,
              serviceName: service.name,
              deploymentId: deployment.id,
              status: deployment.status,
              staticUrl: deployment.staticUrl,
              deploymentStopped: deployment.deploymentStopped,
            });
          }
        }
      }

      hasNextPage = data.data?.projects.pageInfo.hasNextPage ?? false;
      afterCursor = data.data?.projects.pageInfo.endCursor ?? null;
    } catch (error) {
      console.error("Error fetching service info:", error);
      throw error;
    }
  }

  return allServices;
}

app.get("/api/services/status", async (c) => {
  const apiToken = c.req.header("Authorization")?.replace("Bearer ", "");

  if (!apiToken) {
    return c.json({ error: "Unauthorized: API token is required" }, 401);
  }

  try {
    const services = await getRailwayServiceInfo(apiToken);
    return c.json(services);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("GraphQL request failed")
    ) {
      return c.json({ error: "Failed to fetch from Railway API" }, 502);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

app.get("/api/service/:staticUrl/status", async (c) => {
  const apiToken = c.req.header("Authorization")?.replace("Bearer ", "");
  const staticUrl = c.req.param("staticUrl");

  if (!apiToken) {
    return c.json({ error: "Unauthorized: API token is required" }, 401);
  }

  if (!staticUrl) {
    return c.json(
      { error: "Bad Request: staticUrl parameter is required" },
      400
    );
  }

  try {
    const services = await getRailwayServiceInfo(apiToken);
    const service = services.find((s) => s.staticUrl === staticUrl);

    if (!service) {
      return c.json(
        { error: "Not Found: Service with provided staticUrl not found" },
        404
      );
    }

    if (service.status !== "SUCCESS") {
      return c.json(
        {
          serviceName: service.serviceName,
          status: service.status,
        },
        // 503
      );
    }

    return c.json({
      serviceName: service.serviceName,
      status: service.status,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("GraphQL request failed")
    ) {
      return c.json({ error: "Failed to fetch from Railway API" }, 502);
    }
    return c.json({ error: "Internal Server Error" }, 500);
  }
});

// Use proper server implementation
import { serve } from "bun";

serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  fetch: app.fetch,
});
