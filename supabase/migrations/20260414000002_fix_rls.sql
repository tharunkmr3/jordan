-- Fix org_members: drop old policies and recreate without recursion
DROP POLICY IF EXISTS org_members_select ON org_members;
DROP POLICY IF EXISTS org_members_insert ON org_members;
DROP POLICY IF EXISTS org_members_update ON org_members;
DROP POLICY IF EXISTS org_members_delete ON org_members;

CREATE POLICY org_members_select ON org_members FOR SELECT USING (user_id = auth.uid());
CREATE POLICY org_members_insert ON org_members FOR INSERT WITH CHECK (true);
CREATE POLICY org_members_update ON org_members FOR UPDATE USING (
  org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role IN ('owner', 'admin'))
);
CREATE POLICY org_members_delete ON org_members FOR DELETE USING (
  org_id IN (SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid() AND om.role = 'owner')
);

-- Fix organizations: drop old policies (named org_select, org_update) and add INSERT
DROP POLICY IF EXISTS org_select ON organizations;
DROP POLICY IF EXISTS org_update ON organizations;
DROP POLICY IF EXISTS organizations_select ON organizations;
DROP POLICY IF EXISTS organizations_insert ON organizations;
DROP POLICY IF EXISTS organizations_update ON organizations;

CREATE POLICY org_select ON organizations FOR SELECT USING (
  id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
);
CREATE POLICY org_insert ON organizations FOR INSERT WITH CHECK (true);
CREATE POLICY org_update ON organizations FOR UPDATE USING (
  id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);
