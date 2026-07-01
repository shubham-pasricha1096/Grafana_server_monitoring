import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = 'https://test.k6.io';
const SLOW_URL = 'https://httpbin.test.k6.io/delay/2';
const ERROR_URL = 'https://httpbin.test.k6.io/status/500';

export const options = {
  scenarios: {
    
    // ✅ Normal traffic
    normal_traffic: {
      executor: 'ramping-vus',
      startTime: '0s',
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 30 },
        { duration: '30s', target: 10 },
      ],
      exec: 'normalTraffic',
    },

    // 🔥 Traffic spike
    traffic_spike: {
      executor: 'ramping-vus',
      startTime: '2m',
      stages: [
        { duration: '20s', target: 20 },
        { duration: '30s', target: 200 },
        { duration: '40s', target: 200 },
        { duration: '20s', target: 20 },
      ],
      exec: 'trafficSpike',
    },

    // ⏱️ Latency issue (slow endpoint)
    latency_issue: {
      executor: 'ramping-vus',
      startTime: '4m',
      stages: [
        { duration: '20s', target: 5 },
        { duration: '1m', target: 40 },
        { duration: '20s', target: 5 },
      ],
      exec: 'latencyTest',
    },

    // ❌ Error spike
    error_spike: {
      executor: 'ramping-vus',
      startTime: '6m',
      stages: [
        { duration: '20s', target: 5 },
        { duration: '1m', target: 30 },
        { duration: '20s', target: 5 },
      ],
      exec: 'errorTest',
    },

    // 🧠 Saturation (high sustained load)
    saturation_test: {
      executor: 'constant-arrival-rate',
      startTime: '8m',
      rate: 250, // high load
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 100,
      maxVUs: 500,
      exec: 'saturationTest',
    },
  },

  thresholds: {
    http_req_failed: ['rate<0.2'],       // allow errors for testing
    http_req_duration: ['p(95)<3000'],   // allow slow responses
  },
};


// ✅ Normal Traffic
export function normalTraffic() {
  const res = http.get(BASE_URL, { tags: { signal: 'traffic' } });

  check(res, {
    'status is 200': (r) => r.status === 200,
  });

  sleep(1);
}


// 🔥 Traffic Spike
export function trafficSpike() {
  const res = http.get(BASE_URL, { tags: { signal: 'traffic' } });

  check(res, {
    'spike status 200': (r) => r.status === 200,
  });

  sleep(0.2);
}


// ⏱️ Latency Test
export function latencyTest() {
  const res = http.get(SLOW_URL, { tags: { signal: 'latency' } });

  check(res, {
    'slow response received': (r) => r.status === 200,
  });

  sleep(1);
}


// ❌ Error Test
export function errorTest() {
  const res = http.get(ERROR_URL, { tags: { signal: 'error' } });

  check(res, {
    'error endpoint hit': (r) => r.status === 500,
  });

  sleep(0.5);
}


// 🧠 Saturation Test
export function saturationTest() {
  const res = http.get(BASE_URL, { tags: { signal: 'saturation' } });

  check(res, {
    'saturation status 200': (r) => r.status === 200,
  });
}