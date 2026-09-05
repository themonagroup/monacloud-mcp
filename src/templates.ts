import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import { CloudError } from './errors.js';
import { requestJson } from './http.js';

type CatalogEntry = {
  slug: string;
  name: string;
  description: string;
  products: string[];
};

const BUILTIN: CatalogEntry[] = [
  { slug: 'cskh-zalo', name: 'CSKH Zalo', description: 'Trả lời khách từ tài liệu shop và chuyển ca khó cho người.', products: ['MONA AI', 'MONA Base', 'Zalo ZNS'] },
  { slug: 'sales-chot-don', name: 'Sales chốt đơn', description: 'Tư vấn, báo giá, tạo QR MONA Pay và xác nhận tiền vào.', products: ['MONA Pay', 'MONA AI'] },
  { slug: 'ke-toan-hddt', name: 'Kế toán HĐĐT', description: 'Đọc tiền vào, phát hành hoá đơn điện tử và nhắc công nợ.', products: ['MONA Pay', 'monahddt', 'MONA Mail'] },
  { slug: 'content-seo', name: 'Content SEO', description: 'Viết và đăng bài theo voice thương hiệu, có gate QC.', products: ['MONA AI'] },
  { slug: 'noi-bo-kin', name: 'Nội bộ kín', description: 'Trợ lý đọc tài liệu công ty, dữ liệu không rời server.', products: ['MONA Cloud', 'MONA Base', 'Ollama'] },
  { slug: 'tro-giang-academy', name: 'Trợ giảng Academy', description: 'Trợ giảng cho academy của giảng viên.', products: ['mona.academy', 'MONA AI'] },
];

const allowedSlug = /^[a-z0-9][a-z0-9-]{0,79}$/;
const standardFiles = ['README.md', 'AGENTS.md', 'tools.json', 'deploy.md', 'CHECKLIST.md'];

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await readdir(path, { withFileTypes: true })).length >= 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function summaryFromReadme(slug: string, readme?: string): CatalogEntry {
  const lines = (readme || '').split(/\r?\n/).map((line) => line.trim());
  const name = lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, '') || slug;
  const description = lines.find((line) => line && !line.startsWith('#')) || 'MONA Agent template';
  return { slug, name, description, products: [] };
}

export class TemplateCatalog {
  constructor(readonly config: Config, readonly fetchImpl: typeof fetch = fetch) {}

  private assertSlug(slug: string): void {
    if (!allowedSlug.test(slug)) {
      throw new CloudError('invalid_template', 'Tên template không hợp lệ.', 'Gọi agent_templates_list rồi dùng đúng slug trong catalog.');
    }
  }

  async list(): Promise<{ source: string; templates: CatalogEntry[] }> {
    if (await directoryExists(this.config.templatesDir)) {
      const entries = await readdir(this.config.templatesDir, { withFileTypes: true });
      const templates: CatalogEntry[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !allowedSlug.test(entry.name)) continue;
        templates.push(summaryFromReadme(
          entry.name,
          await readOptional(join(this.config.templatesDir, entry.name, 'README.md')),
        ));
      }
      return { source: this.config.templatesDir, templates };
    }
    if (this.config.templatesUrl) {
      const remote = await requestJson<{ templates?: CatalogEntry[] }>(
        `${this.config.templatesUrl}/catalog.json`,
        { fetchImpl: this.fetchImpl },
      );
      return { source: this.config.templatesUrl, templates: Array.isArray(remote.templates) ? remote.templates : [] };
    }
    return { source: 'built-in-wave-1-catalog', templates: BUILTIN };
  }

  async get(slug: string): Promise<Record<string, unknown>> {
    this.assertSlug(slug);
    if (await directoryExists(this.config.templatesDir)) {
      const directory = join(this.config.templatesDir, slug);
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CloudError('template_not_found', `Không có template ${slug}.`, 'Gọi agent_templates_list để xem slug hiện có.');
        }
        throw error;
      }
      const files: Record<string, string> = {};
      for (const filename of standardFiles) {
        const content = await readOptional(join(directory, filename));
        if (content !== undefined) files[filename] = content;
      }
      const skillsEntry = entries.find((entry) => entry.isDirectory() && entry.name === 'skills');
      if (skillsEntry) {
        const skillFiles = await readdir(join(directory, 'skills'), { withFileTypes: true });
        for (const file of skillFiles) {
          if (!file.isFile() || !/\.(md|json|txt)$/i.test(file.name)) continue;
          const content = await readFile(join(directory, 'skills', file.name), 'utf8');
          files[`skills/${file.name}`] = content;
        }
      }
      return { slug, source: directory, files };
    }
    if (this.config.templatesUrl) {
      const remote = await requestJson<Record<string, unknown>>(
        `${this.config.templatesUrl}/templates/${encodeURIComponent(slug)}.json`,
        { fetchImpl: this.fetchImpl },
      );
      return { slug, source: this.config.templatesUrl, ...remote };
    }
    const template = BUILTIN.find((entry) => entry.slug === slug);
    if (!template) {
      throw new CloudError('template_not_found', `Không có template ${slug}.`, 'Gọi agent_templates_list để xem slug hiện có.');
    }
    return {
      ...template,
      source: 'built-in-wave-1-catalog',
      status: 'catalog_only',
      next_step: 'Catalog runtime chưa được phát hành. Deploy repo git: dùng cloud_app_host_list rồi cloud_app_create (đang mở), sandbox trước nếu chưa có app host; báo ước tính và hỏi duyệt trước khi tạo thật.',
    };
  }
}
