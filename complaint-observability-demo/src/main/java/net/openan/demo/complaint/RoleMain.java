/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 *    Licensed under the Apache License, Version 2.0 (the "License"); you may
 *    not use this file except in compliance with the License. You may obtain
 *    a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 *    WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 *    License for the specific language governing permissions and limitations
 *    under the License.
 */

package net.openan.demo.complaint;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.openan.workflow.engine.client.A2ATransport;
import dev.openan.workflow.engine.client.DefaultWorkflowEngineClient;
import dev.openan.workflow.engine.client.WorkflowEngineClient;
import dev.openan.workflow.engine.client.WorkflowEngineClientConfig;
import dev.openan.workflow.engine.control.EventCallback;
import dev.openan.workflow.engine.model.ExecutionResult;
import dev.openan.workflow.engine.model.Workflow;
import dev.openan.workflow.engine.runner.ExecutePsop;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import net.openan.observability.Observability;
import net.openan.observability.ObservabilitySdk;
import net.openan.observability.SdkConfig;
import org.a2aproject.sdk.spec.AgentCard;

/** Starts one role of the multi-process complaint demo. */
public final class RoleMain {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PSOP_RESOURCE = "/scenario/psop_Complaint_Handling_WAIMO.json";

    private RoleMain() {
    }

    public static void main(String[] args) throws Exception {
        RoleSpec spec = RoleSpec.from(System.getProperty("demo.role", args.length == 0 ? "west" : args[0]));
        String caseName = property("demo.case", "success");
        validateCase(caseName);
        String runId = property("demo.run.id", "multiprocess-" + System.currentTimeMillis());
        String bindHost = property("demo.bind.host", "127.0.0.1");
        int port = integerProperty("demo.port", spec.defaultPort());
        String publicUrl = property("demo.public.url", "http://" + bindHost + ":" + port);
        boolean observabilityEnabled = Boolean.parseBoolean(property("demo.otel.enabled", "true"));
        String serviceName = property("demo.service.name", spec.defaultServiceName());
        CountDownLatch shutdown = new CountDownLatch(1);
        HttpMockAgentServer server = null;
        DefaultWorkflowEngineClient ownedClient = null;
        WorkflowEngineClient client = null;
        Map<String, Object> workflowReport = null;
        boolean flushed = false;

        SdkConfig sdkConfig = SdkConfig.builder()
                .serviceName(serviceName)
                .metricInterval(Duration.ofMillis(500))
                .enabled(observabilityEnabled)
                .build();
        try (ObservabilitySdk sdk = ObservabilitySdk.start(sdkConfig)) {
            Path env = Path.of(System.getProperty("demo.a2at.env", "src/main/resources/a2at/demo.env"));
            TaskTCodec taskT = new TaskTCodec(env);
            Observability observe = sdk.observe();
            TraceParentRegistry traceParents = new TraceParentRegistry(null);
            if (spec == RoleSpec.TRANSPORT) {
                WorkflowEngineClientConfig config = clientConfig();
                AgentCard west = card(RoleSpec.WEST, "demo.west.url");
                AgentCard east = card(RoleSpec.EAST, "demo.east.url");
                AgentCard transport = HttpMockAgentServer.agentCard(spec.agentName(), publicUrl);
                AgentCard selectedOmc = HttpMockAgentServer.agentCard(
                        "Selected OMC Agent", west.supportedInterfaces().get(0).url());
                ownedClient = DefaultWorkflowEngineClient.owning(
                        new A2ATransport(
                                List.of(transport, west, east, selectedOmc),
                                new SocketA2AJavaClientRuntime(
                                        config.getSendTimeoutSeconds(), observe, null, traceParents),
                                config),
                        config);
                client = new LocalTaskWorkflowEngineClient(new HttpWorkflowEngineClient(ownedClient), observe, spec.agentName());
                server = HttpMockAgentServer.start(
                        spec.agentName(),
                        new MockAgentRouter(
                                caseName,
                                observe,
                                taskT,
                                client,
                                traceParents,
                                new LayeredTransportWorkflow(caseName, observe, taskT, client)),
                        port,
                        publicUrl,
                        shutdown::countDown);
            } else {
                server = HttpMockAgentServer.start(
                        spec.agentName(),
                        new MockAgentRouter(caseName, observe, taskT, null, traceParents),
                        port,
                        publicUrl,
                        shutdown::countDown);
            }
            System.out.println("ROLE=" + spec.roleName());
            System.out.println("ROLE_URL=" + server.url());
            System.out.println("ROLE_SERVICE=" + serviceName);
            System.out.println("ROLE_READY=true");
            System.out.flush();

            if (spec == RoleSpec.WAIMO) {
                try {
                    WorkflowEngineClientConfig config = clientConfig();
                    AgentCard transport = card(RoleSpec.TRANSPORT, "demo.transport.url");
                    List<AgentCard> cards = List.of(
                            HttpMockAgentServer.agentCard(spec.agentName(), server.url()),
                            transport,
                            card(RoleSpec.WEST, "demo.west.url"),
                            card(RoleSpec.EAST, "demo.east.url"));
                    ownedClient = DefaultWorkflowEngineClient.owning(
                            new A2ATransport(
                                    cards,
                                    new SocketA2AJavaClientRuntime(
                                            config.getSendTimeoutSeconds(),
                                            observe,
                                            null,
                                            traceParents),
                                    config),
                            config);
                    client = new LocalTaskWorkflowEngineClient(new HttpWorkflowEngineClient(ownedClient), observe, spec.agentName());
                    workflowReport = executeWorkflow(
                            caseName,
                            runId,
                            client,
                            observe,
                            List.of(server.url(), transport.supportedInterfaces().get(0).url(),
                                    cards.get(2).supportedInterfaces().get(0).url(),
                                    cards.get(3).supportedInterfaces().get(0).url()),
                            observabilityEnabled,
                            serviceName);
                } catch (RuntimeException | Error failure) {
                    throw failure;
                }
                flushed = sdk.flush(10, TimeUnit.SECONDS);
                workflowReport.put("otelFlush", flushed);
                writeReport(Path.of("artifacts").resolve(runId + ".json"), workflowReport);
                System.out.println("RUN_ID=" + runId);
                System.out.println("STATUS=" + (Boolean.TRUE.equals(workflowReport.get("success"))
                        ? "completed" : "failed"));
                System.out.println("TRANSPORT_MODE=multi-http");
                System.out.println("OTEL_FLUSH=" + flushed);
                System.out.println("REPORT=" + Path.of("artifacts").resolve(runId + ".json").toAbsolutePath());
                System.out.flush();
            }
            shutdown.await(365, TimeUnit.DAYS);
            if (!flushed) {
                flushed = sdk.flush(10, TimeUnit.SECONDS);
            }
        } finally {
            if (ownedClient != null) {
                ownedClient.close();
            }
            if (server != null) {
                List<Map<String, Object>> records = server.records();
                server.close();
                writeRoleReport(spec, runId, caseName, serviceName, server.url(), records,
                        observabilityEnabled, flushed, workflowReport == null ? null : workflowReport.get("error"));
            }
        }
    }

    private static Map<String, Object> executeWorkflow(
            String caseName,
            String runId,
            WorkflowEngineClient client,
            Observability observe,
            List<String> agentUrls,
            boolean observabilityEnabled,
            String serviceName) throws IOException {
        Workflow workflow = loadWorkflow();
        Path env = Path.of(System.getProperty("demo.a2at.env", "src/main/resources/a2at/demo.env"));
        TaskTCodec taskT = new TaskTCodec(env);
        List<Map<String, Object>> events = new ArrayList<>();
        EventCallback callback = new EventCallback() {
            @Override
            public void onEvent(String type, Map<String, Object> data) {
                synchronized (events) {
                    events.add(Map.of("type", type, "data", data));
                }
            }
        };
        ExecutionResult result = ExecutePsop.builder()
                .psop(workflow)
                .engineClient(client)
                .controlPoint(new ComplaintControlPoint(taskT, runId, caseName))
                .runtimeIntent("跨地市企业专线SLA劣化投诉处理")
                .lang("zh")
                .eventCallback(callback)
                .observability(observe)
                .onFinish((finished, collected) -> {
                    synchronized (events) {
                        events.add(Map.of("type", "on_finish", "data", Map.of(
                                "success", finished.isSuccess(),
                                "eventCount", collected.size())));
                    }
                })
                .execute()
                .join();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("runId", runId);
        report.put("case", caseName);
        report.put("transportMode", "multi-http");
        report.put("serviceName", serviceName);
        report.put("workflowId", workflow.getId());
        report.put("success", result.isSuccess());
        report.put("error", result.getError());
        report.put("history", result.getHistory());
        report.put("stepOutputs", result.getStepOutputs());
        report.put("events", events);
        report.put("agentRecords", List.of());
        report.put("agentUrls", agentUrls);
        report.put("observabilityEnabled", observabilityEnabled);
        return report;
    }

    private static void writeRoleReport(
            RoleSpec spec,
            String runId,
            String caseName,
            String serviceName,
            String roleUrl,
            List<Map<String, Object>> records,
            boolean observabilityEnabled,
            boolean otelFlush,
            Object error) throws IOException {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("runId", runId);
        report.put("case", caseName);
        report.put("role", spec.roleName());
        report.put("serviceName", serviceName);
        report.put("roleUrl", roleUrl);
        report.put("agentRecords", records);
        report.put("observabilityEnabled", observabilityEnabled);
        report.put("otelFlush", otelFlush);
        if (error != null) {
            report.put("error", error);
        }
        writeReport(Path.of("artifacts").resolve(runId + "." + spec.roleName() + ".json"), report);
    }

    private static AgentCard card(RoleSpec role, String propertyName) {
        String url = property(propertyName, "http://127.0.0.1:" + role.defaultPort());
        return HttpMockAgentServer.agentCard(role.agentName(), url);
    }

    private static WorkflowEngineClientConfig clientConfig() {
        return WorkflowEngineClientConfig.builder()
                .sslVerify(false)
                .preferredProtocol("HTTP+JSON")
                .sendTimeoutSeconds(30)
                .taskPollIntervalMillis(200)
                .build();
    }

    private static Workflow loadWorkflow() throws IOException {
        try (InputStream input = RoleMain.class.getResourceAsStream(PSOP_RESOURCE)) {
            if (input == null) {
                throw new IOException("Missing PSOP resource " + PSOP_RESOURCE);
            }
            Map<String, Object> data = JSON.readValue(input, new TypeReference<>() {
            });
            return Workflow.fromMap(data);
        }
    }

    private static void writeReport(Path path, Map<String, Object> report) throws IOException {
        Files.createDirectories(path.getParent());
        JSON.writerWithDefaultPrettyPrinter().writeValue(path.toFile(), report);
    }

    private static String property(String name, String fallback) {
        String value = System.getProperty(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static int integerProperty(String name, int fallback) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            return fallback;
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(name + " must be an integer", error);
        }
    }

    private static void validateCase(String caseName) {
        if (!caseName.equals("success") && !caseName.equals("authorization-denied")) {
            throw new IllegalArgumentException("demo.case must be success or authorization-denied");
        }
    }

    private enum RoleSpec {
        WEST("west", "West-GD NETSpirit", "complaint-west", 9101),
        EAST("east", "East-GD NETSpirit", "complaint-east", 9102),
        TRANSPORT("transport", "Transport Complaint Agent", "complaint-transport", 9103),
        WAIMO("waimo", "WAIMO Complaint Agent", "complaint-waimo", 9104);

        private final String roleName;
        private final String agentName;
        private final String defaultServiceName;
        private final int defaultPort;

        RoleSpec(String roleName, String agentName, String defaultServiceName, int defaultPort) {
            this.roleName = roleName;
            this.agentName = agentName;
            this.defaultServiceName = defaultServiceName;
            this.defaultPort = defaultPort;
        }

        static RoleSpec from(String value) {
            for (RoleSpec role : values()) {
                if (role.roleName.equalsIgnoreCase(value)) {
                    return role;
                }
            }
            throw new IllegalArgumentException("demo.role must be west, east, transport, or waimo");
        }

        String roleName() {
            return roleName;
        }

        String agentName() {
            return agentName;
        }

        String defaultServiceName() {
            return defaultServiceName;
        }

        int defaultPort() {
            return defaultPort;
        }
    }
}
