import fs from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { Command } from "commander";
import ejs from "ejs";
import { getProxyForUrl } from "proxy-from-env";
import got from "got";
import hpagent from "hpagent";
import { getProperties } from "properties-file";
import semver from "semver";
import { readFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const buildCommand = (command = new Command()) =>
  command
    .description("Generate a vulnerability report from a SonarQube instance.")
    .addOption(
      command
        .createOption(
          "--http-proxy",
          "the proxy to use to reach the sonarqube instance (http://<host>:<port>)"
        )
        .env("http_proxy")
    )
    .option(
      "--project <project>",
      "name of the project, displayed in the header of the generated report"
    )
    .option(
      "--application <application>",
      "name of the application, displayed in the header of the generated report"
    )
    .option(
      "--release <release>",
      "name of the release, displayed in the header of the generated report"
    )
    .option(
      "--branch <branch>",
      "Branch in Sonarqube that we want to get the issues for"
    )
    .option(
      "--pullrequest <pr>",
      "pull request ID in Sonarqube for which to get the issues/hotspots"
    )
    .option(
      "--sonarurl <url>",
      "base URL of the SonarQube instance to query from"
    )
    .option("--sonarcomponent <component>", "id of the component to query from")
    .option("--sonarusername <username>", "auth username")
    .option("--sonarpassword <password>", "auth password")
    .option("--sonartoken <token>", "auth token")
    .option(
      "--sonarorganization <organization>",
      "name of the sonarcloud.io organization"
    )
    .option(
      "--in-new-code-period",
      "flag to indicate if the reporting should be done using the new code definition (delta analysis).",
      false
    )
    .option(
      "--allbugs",
      "flag to indicate if the report should contain all bugs, not only vulnerabilities.",
      false
    )
    .option(
      "--fix-missing-rule",
      "Extract rules without filtering on type (even if allbugs=false). Not useful if allbugs=true.",
      false
    )
    .option(
      "--no-security-hotspot",
      "Set this flag for old versions of sonarQube without security hotspots (<7.3).",
      true
    )
    .option(
      "--coverage",
      "Set this flag to include code coverage status in the report.",
      false
    )
    .option(
      "--link-issues",
      "Set this flag to create links to Sonar from reported issues",
      false
    )
    .option(
      "--quality-gate-status",
      "Set this flag to include quality gate status in the report.",
      false
    )
    .option(
      "--no-rules-in-report",
      'Set this flag to omit "Known Security Rules" section from report.',
      true
    )
    .option(
      "--only-detected-rules",
      "Set this flag to include only detected rules in the report. Not useful if no-rules-in-report=true.",
      false
    )
    .option(
      "--vulnerability-phrase <phrase>",
      "Set to override 'Vulnerability' phrase in the report.",
      "Vulnerability"
    )
    .option(
      "--vulnerability-plural-phrase <phrase>",
      "Set to override 'Vulnerabilities' phrase in the report. ",
      "Vulnerabilities"
    )
    .option(
      "--save-report-json <filename>",
      "Save the report data in JSON format. Set to target file name",
      ""
    )
    .option(
      "--sonar-properties-file <filename>",
      "To use a sonar properties file.",
      "sonar-project.properties"
    )
    .option(
      "--stylesheet-file <filename>",
      "CSS stylesheet file path. (default: provided stylesheet)"
    )
    .option(
      "--ejs-file <filename>",
      "EJS template file path. (default: built in template)",
      "index.ejs"
    )
    .option("--no-ejs-file", "Disable template file (print only the summary)")
    .option(
      "--output <filename>",
      "Output report file path. (default: report.html)",
      "report.html"
    )
    .option("--exit-code", "Exit with non zero if issues were found")
    .addHelpText(
      "after",
      `
Example
  sonar-report --project=MyProject --application=MyApp --release=v1.0.0 --sonarurl=http://my.sonar.example.com --sonarcomponent=myapp:1.0.0 --in-new-code-period > /tmp/sonar-report`
    );

const generateReport = async (options) => {
  const { onError = () => process.exit(1) } = options;
  function logError(context, error) {
    const { code = "", message = "", response = {} } = error;
    const { statusCode = "", statusMessage = "", body = "" } = response;

    console.error(
      "Error while %s : %s - %s - %s - %s - %s",
      context,
      code,
      message,
      statusCode,
      statusMessage,
      body
    );
    throw error;
  }

  const issueLink = options.linkIssues
    ? (data, issue) => (c) =>
        `<a href="${data.sonarBaseURL}/project/issues?${
          data.branch ? "branch=" + encodeURIComponent(data.branch) + "&" : ""
        }id=${encodeURIComponent(
          data.sonarComponent
        )}&issues=${encodeURIComponent(issue.key)}&open=${encodeURIComponent(
          issue.key
        )}">${c}</a>`
    : (data, issue) => (c) => c;

  const hotspotLink = options.linkIssues
    ? (data, hotspot) => (c) =>
        `<a href="${data.sonarBaseURL}/security_hotspots?${
          data.branch ? "branch=" + encodeURIComponent(data.branch) + "&" : ""
        }id=${encodeURIComponent(
          data.sonarComponent
        )}&hotspots=${encodeURIComponent(hotspot.key)}">${c}</a>`
    : () => (c) => c;

  let severity = new Map();
  severity.set("LOW", 0);
  severity.set("MEDIUM", 1);
  severity.set("HIGH", 2);
  // issueSeverities is compatible for sq version <= 10.1
  let issueSeverities =  { BLOCKER:"HIGH", CRITICAL: "HIGH", MAJOR: "MEDIUM", MINOR: "LOW", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };
  let hotspotSeverities =  { HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW" };

  let properties = [];
  try {
    properties = getProperties(readFileSync(options.sonarPropertiesFile));
  } catch (e) {}

  const data = {
    date: new Date().toLocaleDateString("en-us", {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric",
    }),
    projectName: options.project || properties["sonar.projectName"],
    applicationName: options.application,
    releaseName: options.release,
    pullRequest: options.pullrequest,
    branch: options.branch,
    inNewCodePeriod: options.inNewCodePeriod,
    allBugs: options.allbugs,
    fixMissingRule: options.fixMissingRule,
    noSecurityHotspot: !options.securityHotspot,
    noRulesInReport: !options.rulesInReport,
    onlyDetectedRules: options.onlyDetectedRules,
    vulnerabilityPhrase: options.vulnerabilityPhrase,
    noCoverage: !options.coverage,
    vulnerabilityPluralPhrase: options.vulnerabilityPluralPhrase,
    // sonar URL without trailing /
    sonarBaseURL: options.sonarurl
      ? options.sonarurl.replace(/\/$/, "")
      : properties["sonar.host.url"],
    sonarComponent: options.sonarcomponent || properties["sonar.projectKey"],
    sonarOrganization: options.sonarorganization,
    rules: new Map(),
    issues: [],
    hotspotKeys: [],
  };

  const newCodePeriodFilter = data.inNewCodePeriod
    ? "&inNewCodePeriod=true"
    : "";
  data.deltaAnalysis = data.inNewCodePeriod ? "Yes" : "No";
  const sonarBaseURL = data.sonarBaseURL;
  const sonarComponent = data.sonarComponent;
  const withOrganization = data.sonarOrganization
    ? `&organization=${data.sonarOrganization}`
    : "";
  let headers = {};
  let version = null;

  // the got agent if a forward proxy is required, or remains null
  let agent = null;
  // Preparing configuration if behind proxy
  const proxy = getProxyForUrl(sonarBaseURL);
  if (proxy) {
    const url = new URL(proxy);
    console.error("using proxy: %s", url);
    agent = {
      https: new hpagent.HttpsProxyAgent({
        proxy: proxy,
      }),
    };
  } else {
    console.error("No proxy configuration detected");
  }

  // get SonarQube version
  try {
    const res = await got(`${sonarBaseURL}/api/system/status`, {
      agent,
      headers,
    });
    const json = JSON.parse(res.body);
    version = semver.coerce(json.version);
    console.error("sonarqube version: %s", version);
  } catch (error) {
    logError("getting version", error);
    return null;
  }

  let DEFAULT_ISSUES_FILTER = "";
  let DEFAULT_RULES_FILTER = "";
  let ISSUE_STATUSES = "";
  let HOTSPOT_STATUSES = "TO_REVIEW";

  if (data.noSecurityHotspot || semver.satisfies(version, "<7.3")) {
    // hotspots don't exist
    DEFAULT_ISSUES_FILTER = "&types=VULNERABILITY";
    DEFAULT_RULES_FILTER = "&types=VULNERABILITY";
    ISSUE_STATUSES = "OPEN,CONFIRMED,REOPENED";
  } else if (semver.satisfies(version, "7.3 - 7.8")) {
    // hotspots are stored in the /issues endpoint but issue status doesn't include TO_REVIEW,IN_REVIEW yet
    DEFAULT_ISSUES_FILTER = "&types=VULNERABILITY,SECURITY_HOTSPOT";
    DEFAULT_RULES_FILTER = "&types=VULNERABILITY,SECURITY_HOTSPOT";
    ISSUE_STATUSES = "OPEN,CONFIRMED,REOPENED";
  } else if (semver.satisfies(version, "7.8 - 7.9")) {
    // hotspots are stored in the /issues endpoint and issue status includes TO_REVIEW,IN_REVIEW
    DEFAULT_ISSUES_FILTER = "&types=VULNERABILITY,SECURITY_HOTSPOT";
    DEFAULT_RULES_FILTER = "&types=VULNERABILITY,SECURITY_HOTSPOT";
    ISSUE_STATUSES = "OPEN,CONFIRMED,REOPENED,TO_REVIEW";
  } else {
    // version >= 8.0
    // hotspots are in a dedicated endpoint: rules have type SECURITY_HOTSPOT but issues don't
    DEFAULT_ISSUES_FILTER = "&types=VULNERABILITY";
    DEFAULT_RULES_FILTER = "&types=VULNERABILITY,SECURITY_HOTSPOT";
    ISSUE_STATUSES = "OPEN,CONFIRMED,REOPENED";
  }

  // filters for getting rules and issues
  let filterRule = DEFAULT_RULES_FILTER;
  let filterIssue = DEFAULT_ISSUES_FILTER;
  let filterHotspots = "";
  let filterProjectStatus = "";
  let filterCoverage = "";

  if (data.allBugs) {
    filterRule = "";
    filterIssue = "";
  }

  if (data.pullRequest) {
    filterIssue = filterIssue + "&pullRequest=" + data.pullRequest;
    filterHotspots = filterHotspots + "&pullRequest=" + data.pullRequest;
    filterProjectStatus = "&pullRequest=" + data.pullRequest;
    filterCoverage = "&pullRequest=" + data.pullRequest;
  }

  if (data.branch) {
    filterIssue = filterIssue + "&branch=" + data.branch;
    filterHotspots = filterHotspots + "&branch=" + data.branch;
    filterProjectStatus = "&branch=" + data.branch;
    filterCoverage = "&branch=" + data.branch;
  }

  if (data.fixMissingRule) {
    filterRule = "";
  }

  const username = options.sonarusername || properties["sonar.login"];
  const password = options.sonarpassword || properties["sonar.password"];
  const token = options.sonartoken;
  if (username && password) {
    // Form authentication with username/password
    try {
      const response = await got.post(
        `${sonarBaseURL}/api/authentication/login`,
        {
          agent,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `login=${encodeURIComponent(
            username
          )}&password=${encodeURIComponent(password)}`,
        }
      );
      headers["Cookie"] = response.headers["set-cookie"]
        .map((cookie) => cookie.split(";")[0])
        .join("; ");
    } catch (error) {
      logError("logging in", error);
      return null;
    }
  } else if (token) {
    // Basic authentication with user token
    headers["Authorization"] =
      "Basic " + Buffer.from(token + ":").toString("base64");
  }

  if (data.inNewCodePeriod) {
    const response = await got(
      `${sonarBaseURL}/api/new_code_periods/list?project=${sonarComponent}`,
      {
        agent,
        headers,
      }
    );
    const json = JSON.parse(response.body);
    data.inNewCodePeriod =
      json.newCodePeriods[0].type + " > " + json.newCodePeriods[0].value;
  }

  if (!data.noCoverage) {
    const response = await got(
      `${sonarBaseURL}/api/measures/component?component=${sonarComponent}&metricKeys=coverage${filterCoverage}`,
      {
        agent,
        headers,
      }
    );
    const json = JSON.parse(response.body);
    data.coverage = json.component.measures[0]?.value || 0;
  }

  if (options.qualityGateStatus) {
    try {
      const response = await got(
        `${sonarBaseURL}/api/qualitygates/project_status?projectKey=${sonarComponent}${filterProjectStatus}`,
        {
          agent,
          headers,
        }
      );

      // set values to match alpha characters in sonar
      const conditionValue = new Map();
      conditionValue.set("1", "A");
      conditionValue.set("2", "B");
      conditionValue.set("3", "C");
      conditionValue.set("4", "D");

      const json = JSON.parse(response.body);

      // get date for quality gate status, day month year format
      const qualityGateStatusPeriodDate = json.projectStatus.period?.date || (json.projectStatus.periods.length > 0 && json.projectStatus.periods[0].date);
      data.qualityGateStatusPeriodDate = qualityGateStatusPeriodDate
        ? new Date(qualityGateStatusPeriodDate).toISOString().substring(0, 10)
        : `none`;

      if (json.projectStatus.conditions) {
        for (const condition of json.projectStatus.conditions) {
          condition.metricKey = condition.metricKey.replace(/_/g, " ");
          if (condition.metricKey != "new duplicated lines density") {
            condition.actualValue = conditionValue.get(condition.actualValue);
            condition.errorThreshold = conditionValue.get(
              condition.errorThreshold
            );
          } else {
            condition.actualValue = condition.actualValue + "%";
            condition.errorThreshold = condition.errorThreshold + "%";
          }
        }
      }
      data.qualityGateStatus = json;
    } catch (error) {
      logError("getting quality gate status", error);
      return null;
    }
  } else {
    data.qualityGateStatus = false;
  }

  {
    const pageSize = 500;
    const maxResults = 10000;
    const maxPage = maxResults / pageSize;
    let page = 1;
    let nbResults;

    do {
      try {
        const response = await got(
          `${sonarBaseURL}/api/rules/search?activation=true&f=name,htmlDesc,severity&ps=${pageSize}&p=${page}${filterRule}${withOrganization}`,
          {
            agent,
            headers,
          }
        );
        page++;
        const json = JSON.parse(response.body);
        nbResults = json.rules.length;
        json.rules.forEach((r) =>
          data.rules.set(
            r.key,
            (({ name, htmlDesc, severity }) => ({ name, htmlDesc, severity }))(
              r
            )
          )
        );
      } catch (error) {
        logError("getting rules", error);
        return null;
      }
    } while (nbResults === pageSize && page <= maxPage);
  }

  {
    const pageSize = 500;
    const maxResults = 10000;
    const maxPage = maxResults / pageSize;
    let page = 1;
    let nbResults;
    /** Get all statuses except "REVIEWED".
     * Actions in sonarQube vs status in security hotspot (sonar >= 7):
     * - resolve as reviewed
     *    "resolution": "FIXED"
     *    "status": "REVIEWED"
     * - open as vulnerability
     *    "status": "OPEN"
     * - set as in review
     *    "status": "IN_REVIEW"
     */
    do {
      try {
        const response = await got(
          `${sonarBaseURL}/api/issues/search?componentKeys=${sonarComponent}&ps=${pageSize}&p=${page}&statuses=${ISSUE_STATUSES}&resolutions=&s=STATUS&asc=no${newCodePeriodFilter}${filterIssue}${withOrganization}`,
          {
            agent,
            headers,
          }
        );
        page++;
        const json = JSON.parse(response.body);
        nbResults = json.issues.length;

        //insert code block -- start
        for (let i of json.issues){
          let r = await got(
            `${sonarBaseURL}/api/sources/issue_snippets?issueKey=${i.key}`,
            {
              agent,
              headers,
            }
          );
          let snippets = JSON.parse(r.body);
          let issue_lines = [[i.textRange.startLine, i.textRange.endLine]];

          if('flows' in i && i.flows.length > 0) {
            for (let location of i.flows[0].locations) {
              if(location.component !== i.component) continue;
              issue_lines.push([location.textRange.startLine, location.textRange.endLine]);
            }
          }

          let code_block = '';
          for (let s in snippets) {
            code_block += `<div class="source-info">${s}</div><table class="source-table expand-up expand-down"><tbody>`;
            let now_line = snippets[s].sources[0].line-1;

            for( let j of snippets[s].sources ){
              if(j.line > now_line+1){
                code_block += `</tbody></table><table class="source-table expand-up expand-down"><tbody>`;
              }

              let hint_style = '';
              let pre_style = '';
              for (let range of issue_lines){
                if(j.line >= range[0] && j.line <= range[1]){
                  pre_style = 'class="issue-line"';
                  break;
                }
              }
              code_block += `<tr class="source-line" data-line-number="${j.line}"><td class="source-meta source-line-number" data-line-number="${j.line}">${j.line}</td><td class="source-meta source-line-coverage ${hint_style}" data-line-number="${j.line}"></td><td class="source-line-code code" data-line-number="${j.line}"><div class="source-line-code-inner"><pre ${pre_style}>${j.code}</pre></div></td></tr>`;
              now_line = j.line;
            }

            code_block += `</tbody></table>`;
          }

          i.code_block = code_block;
        }
        //insert code block -- end

        data.issues = data.issues.concat(
          json.issues.map((issue) => {
            const rule = data.rules.get(issue.rule);
            const message = rule ? rule.name : "/";

            return {
              rule: issue.rule,
              // For security hotspots, the vulnerabilities show without a severity before they are confirmed
              // In this case, get the severity from the rule
              severity:
                (typeof issue.severity !== "undefined" && issue.severity in issueSeverities)
                  ? issueSeverities[issue.severity]
                  : issueSeverities[rule.severity],
              status: issue.status,
              link: issueLink(data, issue),
              // Take only filename with path, without project name
              component: issue.component.split(":").pop(),
              line: issue.line,
              description: message,
              message: issue.message,
              key: issue.key,
              code: issue.code_block
            };
          })
        );
      } catch (error) {
        logError("getting issues", error);
        return null;
      }
    } while (nbResults === pageSize && page <= maxPage);

    let hSeverity = "";

    if (!data.noSecurityHotspot && semver.satisfies(version, ">=8.0")) {
      // 1) Listing hotspots with hotspots/search
      page = 1;
      do {
        try {
          const response = await got(
            `${sonarBaseURL}/api/hotspots/search?projectKey=${sonarComponent}${filterHotspots}${newCodePeriodFilter}${withOrganization}&ps=${pageSize}&p=${page}&status=${HOTSPOT_STATUSES}`,
            {
              agent,
              headers,
            }
          );
          page++;
          const json = JSON.parse(response.body);
          nbResults = json.hotspots.length;
          data.hotspotKeys.push(...json.hotspots.map((hotspot) => hotspot.key));
        } catch (error) {
          console.error(
            `${sonarBaseURL}/api/hotspots/search?projectKey=${sonarComponent}${filterHotspots}${newCodePeriodFilter}${withOrganization}&ps=${pageSize}&p=${page}&status=${HOTSPOT_STATUSES}`
          );
          logError("getting hotspots list", error);
          return null;
        }
      } while (nbResults === pageSize && page <= maxPage);

      // 2) Getting hotspots details with hotspots/show
      for (let hotspotKey of data.hotspotKeys) {
        try {
          const response = await got(
            `${sonarBaseURL}/api/hotspots/show?hotspot=${hotspotKey}`,
            {
              agent,
              headers,
            }
          );
          const hotspot = JSON.parse(response.body);

          //insert code block -- start
          let start_line = hotspot.textRange.startLine;
          let end_line = hotspot.textRange.endLine;
          let issue_lines = [[start_line, end_line]];

          if('flows' in hotspot && hotspot.flows.length > 0) {
            for (let location of hotspot.flows[0].locations) {
              if(location.component !== hotspot.component.key) continue;
              
              if(location.textRange.startLine < start_line){
                start_line = location.textRange.startLine;
              }
              
              if(location.textRange.endLine > end_line) {
                end_line = location.textRange.endLine;
              }

              issue_lines.push([location.textRange.startLine, location.textRange.endLine]);
            }
          }

          start_line = (start_line - 10 >= 1)?(start_line - 10):1;
          end_line = end_line + 10;
          
          let r = await got(
            `${sonarBaseURL}/api/sources/lines?key=${hotspot.component.key}&from=${start_line}&to=${end_line}`,
            {
              agent,
              headers,
            }
          );
          let snippet = JSON.parse(r.body);

          let code_block = '';
          code_block += `<div class="source-info">${hotspot.component.key}</div><table class="source-table expand-up expand-down"><tbody>`;
          let now_line = snippet.sources[0].line-1;

          for( let j of snippet.sources ){
            if(j.line > now_line+1){
              code_block += `</tbody></table><table class="source-table expand-up expand-down"><tbody>`;
            }
            
            let hint_style = '';
            let pre_style = '';
            for (let range of issue_lines){
              if(j.line >= range[0] && j.line <= range[1]){
                pre_style = 'class="issue-line"';
                break;
              }
            }
            code_block += `<tr class="source-line" data-line-number="${j.line}"><td class="source-meta source-line-number" data-line-number="${j.line}">${j.line}</td><td class="source-meta source-line-coverage ${hint_style}" data-line-number="${j.line}"></td><td class="source-line-code code" data-line-number="${j.line}"><div class="source-line-code-inner"><pre ${pre_style}>${j.code}</pre></div></td></tr>`;
            now_line = j.line;
          }

          code_block += `</tbody></table>`;
          //insert code block -- end

          hSeverity = hotspotSeverities[hotspot.rule.vulnerabilityProbability];
          if (hSeverity === undefined) {
            hSeverity = "MEDIUM";
            console.error(
              "Unknown hotspot severity: %s",
              hotspot.vulnerabilityProbability
            );
          }
          data.issues.push({
            rule: hotspot.rule.key,
            severity: hSeverity,
            status: hotspot.status,
            link: hotspotLink(data, hotspot),
            // Take only filename with path, without project name
            component: hotspot.component.key.split(":").pop(),
            line: hotspot.line,
            description: hotspot.rule ? hotspot.rule.name : "/",
            message: hotspot.message,
            key: hotspot.key,
            code: code_block
          });
        } catch (error) {
          logError("getting hotspots details", error);
          return null;
        }
      }
    }

    data.issues.sort(function (a, b) {
      return severity.get(b.severity) - severity.get(a.severity);
    });

    data.summary = {
      high: data.issues.filter((issue) => issue.severity === "HIGH")
        .length,
      medium: data.issues.filter((issue) => issue.severity === "MEDIUM").length,
      low: data.issues.filter((issue) => issue.severity === "LOW").length,
    };
  }

  // Iterate over all rules and remove those that have no issues
  if (!data.noRulesInReport && data.onlyDetectedRules) {
    for (let [key, value] of data.rules) {
      if (!data.issues.some((issue) => issue.rule === key)) {
        data.rules.delete(key);
      }
    }
  }

  console.error(await ejs.renderFile(__dirname + "/summary.txt.ejs", data, {}));

  if (options.saveReportJson) {
    const replacer = (key, value) => {
      // JSON.stringify() not convert ES6 Map() to value, this replacer will apply for rules to add rules to json response.
      // https://stackoverflow.com/questions/29085197/how-do-you-json-stringify-an-es6-map
      if (key === "rules") {
        return Array.from(value).reduce((obj, [key, value]) => {
            obj[key] = value;
            return obj;
            }, {});
      } else {
        return value
      }
    }

    await fs.writeFile(options.saveReportJson, JSON.stringify(data, replacer, 2));
  }

  if (options.ejsFile) {
    const stylesheetFile = options.stylesheetFile || __dirname + "/style.css";
    const stylesheet = await fs.readFile(stylesheetFile, "binary");
    console.error("using stylesheet file: %s", stylesheetFile);

    const builtInEjs = resolve(__dirname, options.ejsFile);
    const ejsFile = existsSync(builtInEjs)
      ? builtInEjs
      : resolve(options.ejsFile);

    const renderedFile = await ejs.renderFile(
      ejsFile,
      { ...data, stylesheet },
      {}
    );
    await fs.writeFile(options.output, renderedFile);
  }
  if (options.exitCode && data.issues.length > 0) {
    const error = new Error(`Issues were found`);
    error.data = data;
    onError(error);
  }
  return data;
};

export { buildCommand, generateReport };
