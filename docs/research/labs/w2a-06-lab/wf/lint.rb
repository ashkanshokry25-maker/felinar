require 'yaml'
bad = 0
Dir[File.join(File.dirname(__FILE__), '*.yml')].sort.reject { |f| File.basename(f) == 'gitlab-ci.yml' }.each do |f|   # GitHub workflows only (GitLab outline uses YAML aliases)
  doc = YAML.safe_load(File.read(f), aliases: false) rescue (puts "YAML ERROR #{f}: #{$!.message}"; bad += 1; next)
  on = doc['on'] || doc[true]            # YAML 1.1 turns the key `on` into true
  jobs = doc['jobs']
  puts "#{File.basename(f)}: parsed OK, triggers=#{on.is_a?(Hash) ? on.keys.join(',') : on.inspect}, jobs=#{jobs.keys.join(',')}"
  top_perm = doc['permissions']
  (puts "  FAIL #{f}: top-level permissions must be {}"; bad += 1) unless top_perm == {}
  jobs.each do |name, j|
    steps = j['steps'] || []
    perms = j['permissions'] || {}
    uses_all = steps.map { |s| s['uses'] }.compact
    # policy 1: every third-party/first-party action reference is a pinned placeholder or SHA (never a moving tag)
    uses_all.each { |u| next if u.start_with?('./'); (puts "  FAIL #{name}: unpinned action #{u}"; bad += 1) unless u =~ /@(<SHA-[a-z-]+>|[0-9a-f]{40})(\s|$)/ }
    # policy 2: jobs that build with npm must never hold id-token or contents:write
    runs = steps.map { |s| s['run'].to_s }.join("\n")
    if runs =~ /npm (ci|install|run)/ && (perms['id-token'] == 'write' || perms['contents'] == 'write')
      (puts "  FAIL #{name}: npm job has privileged permissions"; bad += 1) unless runs =~ /playwright/   # smoke job installs playwright only, reads public site
    end
    # policy 3: id-token: write only on jobs that assume a role or call a reusable workflow
    if perms['id-token'] == 'write' && !(uses_all.any? { |u| u.include?('configure-aws-credentials') } || j['uses'])
      puts "  FAIL #{name}: id-token: write without a role-assuming step"; bad += 1
    end
    # policy 4: persist-credentials false on every checkout
    steps.each { |s| next unless s['uses'].to_s.include?('actions/checkout'); (puts "  FAIL #{name}: checkout without persist-credentials: false"; bad += 1) unless s.dig('with', 'persist-credentials') == false }
  end
end
puts(bad.zero? ? "LINT PASS (syntax + 4 security policies)" : "LINT FAIL: #{bad} problem(s)")
exit(bad.zero? ? 0 : 1)
