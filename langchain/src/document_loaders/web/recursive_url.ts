import { JSDOM } from "jsdom";
import { Document } from "../../document.js";
import { AsyncCaller } from "../../util/async_caller.js";
import { BaseDocumentLoader, DocumentLoader } from "../base.js";

export interface RecursiveUrlLoaderOptions {
  excludeDirs?: string[];
  extractor?: (text: string) => string;
  maxDepth?: number;
  timeout?: number;
  preventOutside?: boolean;
  callerOptions?: ConstructorParameters<typeof AsyncCaller>[0];
}

export class RecursiveUrlLoader
  extends BaseDocumentLoader
  implements DocumentLoader
{
  private caller: AsyncCaller;

  private url: string;

  private excludeDirs: string[];

  private extractor: (text: string) => string;

  private maxDepth: number;

  private timeout: number;

  private preventOutside: boolean;

  constructor(url: string, options: RecursiveUrlLoaderOptions) {
    super();

    this.caller = new AsyncCaller({
      maxConcurrency: 64,
      maxRetries: 0,
      ...options.callerOptions,
    });

    this.url = url;
    this.excludeDirs = options.excludeDirs ?? [];
    this.extractor = options.extractor ?? ((s: string) => s);
    this.maxDepth = options.maxDepth ?? 2;
    this.timeout = options.timeout ?? 10000;
    this.preventOutside = options.preventOutside ?? true;
  }

  private async fetchWithTimeout(
    resource: string,
    options: { timeout: number } & RequestInit
  ): Promise<Response> {
    const { timeout, ...rest } = options;
    return this.caller.call(() =>
      fetch(resource, { ...rest, signal: AbortSignal.timeout(timeout) })
    );
  }

  private getChildLinks(html: string, baseUrl: string): Array<string> {
    const allLinks = Array.from(
      new JSDOM(html).window.document.querySelectorAll("a")
    ).map((a) => a.href);
    const absolutePaths = [];
    // eslint-disable-next-line no-script-url
    const invalidPrefixes = [
      "javascript:",
      "mailto:",
      "#",
      "about:",
      "tel:",
      "data:",
      "sms:",
      "fax:",
    ];
    const invalidSuffixes = [
      ".css",
      ".js",
      ".ico",
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".svg",
    ];

    for (const link of allLinks) {
      if (
        invalidPrefixes.some((prefix) => link.startsWith(prefix)) ||
        invalidSuffixes.some((suffix) => link.endsWith(suffix))
      )
        continue;

      let standardizedLink: string;

      if (link.startsWith("http")) {
        standardizedLink = link;
      } else if (link.startsWith("//")) {
        const base = new URL(baseUrl);
        standardizedLink = base.protocol + link;
      } else {
        standardizedLink = new URL(link, baseUrl).href;
      }

      if (this.excludeDirs.some((exDir) => standardizedLink.startsWith(exDir)))
        continue;

      if (link.startsWith("http")) {
        const isAllowed = !this.preventOutside || link.startsWith(baseUrl);
        if (isAllowed) absolutePaths.push(link);
      } else if (link.startsWith("//")) {
        const base = new URL(baseUrl);
        absolutePaths.push(base.protocol + link);
      } else {
        const newLink = new URL(link, baseUrl).href;
        absolutePaths.push(newLink);
      }
    }

    return Array.from(new Set(absolutePaths));
  }

  private extractMetadata(rawHtml: string, url: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const metadata: Record<string, any> = { source: url };
    const { document } = new JSDOM(rawHtml).window;

    const title = document.getElementsByTagName("title")[0];
    if (title) {
      metadata.title = title.textContent;
    }

    const description = document.querySelector("meta[name=description]");
    if (description) {
      metadata.description = description.getAttribute("content");
    }

    const html = document.getElementsByTagName("html")[0];
    if (html) {
      metadata.language = html.getAttribute("lang");
    }

    return metadata;
  }

  private async getUrlAsDoc(url: string): Promise<Document | null> {
    let resText;
    let urlResponse = url;
    try {
      const res = await this.fetchWithTimeout(url, { timeout: this.timeout });
      resText = await res.text();
      urlResponse = res.url;
    } catch (e) {
      return null;
    }

    return {
      pageContent: this.extractor(resText),
      metadata: this.extractMetadata(urlResponse, url),
    };
  }

  private async getChildUrlsRecursive(
    inputUrl: string,
    visited: Set<string> = new Set<string>(),
    depth = 0
  ): Promise<Document[]> {
    if (depth >= this.maxDepth) return [];


    const isExcluded = this.excludeDirs.some((exDir) => inputUrl.startsWith(exDir));
    if (isExcluded) return [];

    let res;
    try {
      res = await this.fetchWithTimeout(inputUrl, { timeout: this.timeout });
      res = await res.text();
    } catch (e) {
      return [];
    }

    const childUrls: string[] = this.getChildLinks(res, inputUrl);

    const results = await Promise.all(
      childUrls.map((childUrl) =>
        (async () => {
          if (visited.has(childUrl)) return null;
          visited.add(childUrl);

          const childDoc = await this.getUrlAsDoc(childUrl);
          if (!childDoc) return null;

          const finalSource = childDoc.metadata["source"];
          if (childUrl !== finalSource && visited.has(finalSource)) {
            return [];
          }

          const childUrlResponses = await this.getChildUrlsRecursive(
            childUrl,
            visited,
            depth + 1
          );
          return [childDoc, ...childUrlResponses];
        })()
      )
    );

    return results.flat().filter((docs) => docs !== null) as Document[];
  }

  async load(): Promise<Document[]> {
    const rootDoc = await this.getUrlAsDoc(this.url);
    if (!rootDoc) return [];

    const docs = [rootDoc];
    docs.push(
      ...(await this.getChildUrlsRecursive(this.url, new Set([this.url])))
    );
    return docs;
  }
}
